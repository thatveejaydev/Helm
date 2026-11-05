use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Emitter;
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
};
use tokio_tungstenite::{
    accept_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};

const PORT: u16 = 48139;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub match_name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub connected: bool,
    pub effects: Vec<Effect>,
    pub error: Option<String>,
    pub pairing_key: String,
    pub port: u16,
    pub shortcut: String,
}

struct Request {
    id: String,
    payload: Value,
    reply: oneshot::Sender<Result<Value, String>>,
}

pub struct Bridge {
    snapshot: Mutex<Snapshot>,
    sender: Mutex<Option<mpsc::Sender<Request>>>,
    busy: tokio::sync::Mutex<()>,
    root: PathBuf,
}

impl Bridge {
    pub fn new(default_shortcut: &str, root: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(&root)?;
        let key_path = root.join("pairing-key");
        let pairing_key = match std::fs::read_to_string(&key_path) {
            Ok(key) if key.trim().len() == 32 => key.trim().to_string(),
            _ => {
                let key = uuid::Uuid::new_v4().simple().to_string();
                std::fs::write(&key_path, &key)?;
                key
            }
        };
        let shortcut_path = root.join("shortcut");
        let shortcut = match std::fs::read_to_string(&shortcut_path) {
            Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
            _ => default_shortcut.to_string(),
        };
        Ok(Self {
            snapshot: Mutex::new(Snapshot {
                connected: false,
                effects: vec![],
                error: None,
                pairing_key,
                port: PORT,
                shortcut,
            }),
            sender: Mutex::new(None),
            busy: tokio::sync::Mutex::new(()),
            root,
        })
    }

    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().unwrap().clone()
    }

    fn emit(&self, app: &tauri::AppHandle) {
        let _ = app.emit("bridge-changed", self.snapshot());
    }

    pub fn set_error(&self, app: &tauri::AppHandle, error: String) {
        self.snapshot.lock().unwrap().error = Some(error);
        self.emit(app);
    }

    pub fn update_shortcut(&self, app: &tauri::AppHandle, shortcut: String) -> Result<(), std::io::Error> {
        let shortcut_path = self.root.join("shortcut");
        std::fs::write(&shortcut_path, &shortcut)?;
        {
            let mut state = self.snapshot.lock().unwrap();
            state.shortcut = shortcut;
            state.error = None;
        }
        self.emit(app);
        Ok(())
    }

    pub async fn request(&self, command: &str, payload: Value) -> Result<Value, String> {
        let _guard = self
            .busy
            .try_lock()
            .map_err(|_| "Another command is still running.".to_string())?;
        let sender = self
            .sender
            .lock()
            .unwrap()
            .clone()
            .ok_or("Connect the Helm panel in Premiere first.")?;
        let id = uuid::Uuid::new_v4().to_string();
        let (reply, result) = oneshot::channel();
        let mut message = match payload {
            Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };
        message.insert("type".to_string(), json!("command"));
        message.insert("id".to_string(), json!(id));
        message.insert("command".to_string(), json!(command));
        sender
            .try_send(Request {
                payload: Value::Object(message),
                id,
                reply,
            })
            .map_err(|_| "Premiere connection is unavailable.".to_string())?;
        tokio::time::timeout(Duration::from_secs(30), result)
            .await
            .map_err(|_| {
                "Premiere has not confirmed the command. Check the timeline before trying again."
                    .to_string()
            })?
            .map_err(|_| {
                "Premiere disconnected before confirming the command. Check the timeline."
                    .to_string()
            })?
    }
}

pub async fn serve(app: tauri::AppHandle, bridge: Arc<Bridge>) {
    let listener = match TcpListener::bind(("127.0.0.1", PORT)).await {
        Ok(listener) => listener,
        Err(error) => {
            bridge.set_error(
                &app,
                format!("Cannot start the local bridge on port {PORT}: {error}"),
            );
            return;
        }
    };
    // Authenticate sockets concurrently so an idle, unauthenticated socket cannot block Premiere.
    while let Ok((stream, _)) = listener.accept().await {
        let app = app.clone();
        let bridge = bridge.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = connection(stream, app, bridge).await {
                eprintln!("Helm bridge: {error}");
            }
        });
    }
}

async fn connection(
    stream: TcpStream,
    app: tauri::AppHandle,
    bridge: Arc<Bridge>,
) -> Result<(), String> {
    stream.set_nodelay(true).map_err(|e| e.to_string())?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(4 * 1024 * 1024))
        .max_frame_size(Some(4 * 1024 * 1024));
    let mut socket = tokio::time::timeout(
        Duration::from_secs(5),
        accept_async_with_config(stream, Some(config)),
    )
    .await
    .map_err(|_| "Handshake timeout")?
    .map_err(|e| e.to_string())?;
    let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .map_err(|_| "Authentication timeout")?
        .ok_or("Socket closed")?
        .map_err(|e| e.to_string())?;
    let hello: Value = serde_json::from_str(message.to_text().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let expected = bridge.snapshot().pairing_key;
    if hello["type"] != "hello"
        || hello["protocol"] != 1
        || hello["key"].as_str() != Some(&expected)
    {
        let _ = socket
            .send(Message::text(
                json!({"type":"error", "error":"Pairing key does not match. Copy it from Helm."})
                    .to_string(),
            ))
            .await;
        return Err("Authentication rejected".into());
    }
    let (sender, mut outgoing) = mpsc::channel::<Request>(8);
    {
        let mut current = bridge.sender.lock().unwrap();
        if current.is_some() {
            return Err("A Premiere bridge is already connected".into());
        }
        *current = Some(sender);
    }
    {
        let mut state = bridge.snapshot.lock().unwrap();
        state.connected = true;
        state.effects.clear();
        state.error = None;
    }
    bridge.emit(&app);
    let mut pending: HashMap<String, oneshot::Sender<Result<Value, String>>> = HashMap::new();
    let run = async {
        socket.send(Message::text("{\"type\":\"welcome\",\"protocol\":1}")).await.map_err(|e| e.to_string())?;
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        let mut last_seen = tokio::time::Instant::now();
        loop {
            tokio::select! {
                request = outgoing.recv() => {
                    let Some(request) = request else { break };
                    pending.retain(|_, sender| !sender.is_closed());
                    pending.insert(request.id, request.reply);
                    socket.send(Message::text(request.payload.to_string())).await.map_err(|e| e.to_string())?;
                }
                incoming = socket.next() => {
                    let Some(incoming) = incoming else { break };
                    last_seen = tokio::time::Instant::now();
                    match incoming.map_err(|e| e.to_string())? {
                        Message::Text(text) => {
                            let message: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                            match message["type"].as_str() {
                                Some("catalog") => {
                                    let effects: Vec<Effect> = serde_json::from_value(message["effects"].clone()).map_err(|e| e.to_string())?;
                                    if effects.len() > 50_000 || effects.iter().any(|effect|
                                        !["video", "audio"].contains(&effect.kind.as_str()) || effect.id.is_empty() || effect.name.is_empty()) {
                                        return Err("Invalid effect catalog".into());
                                    }
                                    bridge.snapshot.lock().unwrap().effects = effects;
                                    bridge.emit(&app);
                                }
                                Some("result") => {
                                    if let Some(id) = message["id"].as_str() {
                                        if let Some(reply) = pending.remove(id) {
                                            let result = if message["ok"] == true {
                                                Ok(message["result"].clone())
                                            } else {
                                                Err(message["error"].as_str().unwrap_or("Premiere command failed.").to_string())
                                            };
                                            let _ = reply.send(result);
                                        }
                                    }
                                }
                                Some("error") => bridge.set_error(&app, message["error"].as_str().unwrap_or("Premiere bridge error").to_string()),
                                _ => {}
                            }
                        }
                        Message::Close(_) => break,
                        Message::Ping(data) => socket.send(Message::Pong(data)).await.map_err(|e| e.to_string())?,
                        _ => {}
                    }
                }
                _ = heartbeat.tick() => {
                    if last_seen.elapsed() > Duration::from_secs(45) { return Err("Premiere connection timed out".into()); }
                    socket.send(Message::Ping(vec![].into())).await.map_err(|e| e.to_string())?;
                }
            }
        }
        Ok::<(), String>(())
    }.await;
    *bridge.sender.lock().unwrap() = None;
    bridge.snapshot.lock().unwrap().connected = false;
    for (_, reply) in pending {
        let _ = reply.send(Err(
            "Premiere disconnected. Check the timeline before retrying.".into(),
        ));
    }
    if let Err(error) = &run {
        bridge.snapshot.lock().unwrap().error = Some(error.clone());
    }
    bridge.emit(&app);
    run
}
