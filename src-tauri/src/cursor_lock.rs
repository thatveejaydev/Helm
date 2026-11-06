use std::sync::Mutex;
use windows::Win32::{
    Foundation::{POINT, RECT},
    UI::WindowsAndMessaging::{ClipCursor, GetClipCursor, GetCursorPos},
};

pub const COMMAND_ID: &str = "command:lock-cursor-horizontally";

struct CursorLock {
    shortcut: u32,
    previous: RECT,
    strip: RECT,
}

struct State {
    watching_foreground: bool,
    active: Option<CursorLock>,
}

static STATE: Mutex<State> = Mutex::new(State {
    watching_foreground: false,
    active: None,
});

pub fn enable() {
    STATE.lock().unwrap().watching_foreground = true;
}

pub fn engage(shortcut: u32) -> Result<(), String> {
    let mut state = STATE.lock().unwrap();
    if state.active.is_some() || crate::platform::foreground_premiere().is_none() {
        return Ok(());
    }
    if !state.watching_foreground {
        return Err(
            "Could not lock the cursor because Premiere focus is not being monitored.".into(),
        );
    }

    let mut point = POINT::default();
    let mut previous = RECT::default();
    unsafe {
        GetClipCursor(&mut previous)
            .and_then(|()| GetCursorPos(&mut point))
            .map_err(|error| format!("Could not read the cursor position or bounds: {error}"))?;
    }
    let strip = RECT {
        top: point.y,
        bottom: point.y + 1,
        ..previous
    };
    unsafe { ClipCursor(Some(&strip)) }
        .map_err(|error| format!("Could not lock the cursor: {error}"))?;
    state.active = Some(CursorLock {
        shortcut,
        previous,
        strip,
    });
    Ok(())
}

fn restore(active: &mut Option<CursorLock>) {
    let Some(lock) = active.as_ref() else { return };
    let mut current = RECT::default();
    // Preserve any confinement that another application has applied since the press.
    let replaced = unsafe { GetClipCursor(&mut current) }.is_ok() && current != lock.strip;
    if replaced || unsafe { ClipCursor(Some(&lock.previous)) }.is_ok() {
        *active = None;
    }
}

pub fn release_shortcut(shortcut: u32) {
    let mut state = STATE.lock().unwrap();
    if state
        .active
        .as_ref()
        .is_some_and(|lock| lock.shortcut == shortcut)
    {
        restore(&mut state.active);
    }
}

pub fn release() {
    restore(&mut STATE.lock().unwrap().active);
}
