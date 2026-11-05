use roxmltree::{Document, Node};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::SystemTime,
};

const LIBRARY_NAME: &str = "Effect Presets and Custom Items.prfpset";

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PresetParamValue {
    Number { value: f64 },
    Boolean { value: bool },
    Point { x: f64, y: f64 },
    Color {
        red: f64,
        green: f64,
        blue: f64,
        alpha: f64,
    },
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PresetParam {
    pub index: usize,
    pub name: String,
    pub value: PresetParamValue,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PresetFilter {
    pub kind: String,
    pub name: String,
    pub match_name: String,
    pub params: Vec<PresetParam>,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub folders: Vec<String>,
    pub direct_apply: bool,
    pub filters: Vec<PresetFilter>,
}

#[derive(Default)]
pub struct PresetLibrary(Mutex<Option<CachedLibrary>>);

struct CachedLibrary {
    path: PathBuf,
    modified: SystemTime,
    len: u64,
    presets: Vec<Preset>,
}

impl CachedLibrary {
    fn matches(&self, path: &Path, modified: SystemTime, len: u64) -> bool {
        self.path == path && self.modified == modified && self.len == len
    }
}

impl PresetLibrary {
    pub fn has_changed(&self, documents: &Path) -> bool {
        let current = find_library(documents);
        let cache = self.0.lock().unwrap();
        match (current, cache.as_ref()) {
            (Some((path, modified, len)), Some(cached)) => !cached.matches(&path, modified, len),
            (None, None) => false,
            _ => true,
        }
    }

    pub fn load(&self, documents: &Path, refresh: bool) -> Result<Vec<Preset>, String> {
        let mut cache = self.0.lock().unwrap();
        let Some((path, modified, len)) = find_library(documents) else {
            *cache = None;
            return Ok(Vec::new());
        };
        if let Some(cached) = cache.as_ref() {
            if !refresh && cached.matches(&path, modified, len) {
                return Ok(cached.presets.clone());
            }
        }
        let xml = fs::read_to_string(&path)
            .map_err(|error| format!("Could not read Premiere presets: {error}"))?;
        let presets = parse_library(&xml)?;
        *cache = Some(CachedLibrary {
            path,
            modified,
            len,
            presets: presets.clone(),
        });
        Ok(presets)
    }

    pub fn find(&self, id: &str) -> Result<Preset, String> {
        let cache = self.0.lock().unwrap();
        cache
            .as_ref()
            .and_then(|cache| cache.presets.iter().find(|preset| preset.id == id).cloned())
            .ok_or_else(|| "Refresh Premiere presets and choose the preset again.".to_string())
    }
}

fn find_library(documents: &Path) -> Option<(PathBuf, SystemTime, u64)> {
    let premiere = documents.join("Adobe").join("Premiere Pro");
    fs::read_dir(premiere)
        .ok()?
        .flatten()
        .filter_map(|version| fs::read_dir(version.path()).ok())
        .flatten()
        .flatten()
        .filter(|profile| {
            profile
                .file_name()
                .to_string_lossy()
                .starts_with("Profile-")
        })
        .filter_map(|profile| {
            let path = profile.path().join(LIBRARY_NAME);
            let meta = fs::metadata(&path).ok()?;
            Some((path, meta.modified().ok()?, meta.len()))
        })
        .max_by_key(|(_, modified, _)| *modified)
}

fn child<'a, 'input>(node: Node<'a, 'input>, tag: &str) -> Option<Node<'a, 'input>> {
    node.children().find(|child| child.has_tag_name(tag))
}

fn parse_library(xml: &str) -> Result<Vec<Preset>, String> {
    let document = Document::parse(xml.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("Could not parse Premiere’s preset library: {error}"))?;
    let root = document.root_element();
    let objects: HashMap<_, _> = root
        .children()
        .filter_map(|node| Some((node.attribute("ObjectID")?, node)))
        .collect();
    let preset_bin = root.children().find(|node| {
        node.has_tag_name("BinTreeItem")
            && node
                .descendants()
                .any(|child| child.has_tag_name("HandlerEffects.EffectItemTree.PresetsBin"))
    });
    let mut presets = Vec::new();
    if let Some(bin) = preset_bin {
        read_bin(
            bin,
            &objects,
            &mut Vec::new(),
            &mut HashSet::new(),
            &mut presets,
        );
    }
    Ok(presets)
}

fn read_bin<'a, 'input>(
    bin: Node<'a, 'input>,
    objects: &HashMap<&'a str, Node<'a, 'input>>,
    folders: &mut Vec<String>,
    visited: &mut HashSet<&'a str>,
    presets: &mut Vec<Preset>,
) {
    let Some(bin_id) = bin.attribute("ObjectID") else {
        return;
    };
    if folders.len() >= 64 || !visited.insert(bin_id) {
        return;
    }
    let folder = child(bin, "TreeItemBase")
        .and_then(|base| child(base, "Name"))
        .and_then(|name| name.text())
        .unwrap_or("Presets");
    folders.push(folder.to_string());
    if let Some(items) = child(bin, "Items") {
        for item in items.children().filter(|item| item.has_tag_name("Item")) {
            let Some(id) = item.attribute("ObjectRef") else {
                continue;
            };
            let Some(&entry) = objects.get(id) else {
                continue;
            };
            if entry.has_tag_name("BinTreeItem") {
                read_bin(entry, objects, folders, visited, presets);
                continue;
            }
            let Some(base) = child(entry, "TreeItemBase") else {
                continue;
            };
            let Some(data) = child(base, "Data")
                .and_then(|data| data.attribute("ObjectRef"))
                .and_then(|reference| objects.get(reference))
            else {
                continue;
            };
            if !data.has_tag_name("FilterPresetItem") {
                continue;
            }
            let Some(name) = child(base, "Name").and_then(|name| name.text()) else {
                continue;
            };
            let uid = base
                .descendants()
                .find(|node| node.has_tag_name("MZ.EffectPresets.PresetUID"))
                .and_then(|node| node.text())
                .unwrap_or(id);
            let (direct_apply, filters) = parse_filter_preset_item(*data, objects);
            presets.push(Preset {
                id: format!("preset:{uid}:{id}"),
                name: name.to_string(),
                folders: folders.clone(),
                direct_apply,
                filters,
            });
        }
    }
    folders.pop();
}

fn parse_filter_preset_item<'a, 'input>(
    data: Node<'a, 'input>,
    objects: &HashMap<&'a str, Node<'a, 'input>>,
) -> (bool, Vec<PresetFilter>) {
    let Some(filter_presets_node) = child(data, "FilterPresets") else {
        return (false, Vec::new());
    };
    let mut direct_apply = true;
    let mut filters = Vec::new();
    let mut seen_audio_names = HashSet::new();

    for fp_item in filter_presets_node
        .children()
        .filter(|n| n.has_tag_name("FilterPreset"))
    {
        let Some(fp_ref) = fp_item.attribute("ObjectRef") else {
            direct_apply = false;
            continue;
        };
        let Some(&fp_node) = objects.get(fp_ref) else {
            direct_apply = false;
            continue;
        };
        if let Some(transition_dur) = child(fp_node, "TransitionDuration")
            .and_then(|n| n.text())
            .and_then(|t| t.trim().parse::<i64>().ok())
        {
            if transition_dur > 0 {
                direct_apply = false;
            }
        }
        let fp_match_name = child(fp_node, "FilterMatchName")
            .and_then(|n| n.text())
            .unwrap_or("")
            .trim();
        let Some(comp_node) = child(fp_node, "Component")
            .and_then(|c| c.attribute("ObjectRef"))
            .and_then(|r| objects.get(r))
            .copied()
        else {
            direct_apply = false;
            continue;
        };

        if comp_node.has_tag_name("VideoFilterComponent") {
            if child(comp_node, "SubComponents")
                .map(|sc| sc.children().any(|c| c.is_element()))
                .unwrap_or(false)
            {
                direct_apply = false;
            }
            let inner_comp = child(comp_node, "Component");
            if child(comp_node, "PremiereFilterPrivateData").is_some()
                || child(comp_node, "OpaqueData").is_some()
                || inner_comp.and_then(|ic| child(ic, "PremiereFilterPrivateData")).is_some()
            {
                direct_apply = false;
            }
            let display_name = inner_comp
                .and_then(|c| child(c, "DisplayName"))
                .and_then(|n| n.text())
                .unwrap_or("")
                .trim()
                .to_string();
            let match_name = child(comp_node, "MatchName")
                .and_then(|n| n.text())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or(fp_match_name)
                .to_string();
            if match_name.is_empty() {
                direct_apply = false;
            }
            let (params_ok, params) = parse_component_params(inner_comp, objects);
            if !params_ok || !params.is_empty() {
                direct_apply = false;
            }
            filters.push(PresetFilter {
                kind: "video".to_string(),
                name: if display_name.is_empty() {
                    match_name.clone()
                } else {
                    display_name
                },
                match_name,
                params,
            });
        } else if comp_node.has_tag_name("AudioFilterComponent") {
            let audio_comp = child(comp_node, "AudioComponent");
            if child(comp_node, "OpaqueData").is_some()
                || audio_comp.and_then(|ac| child(ac, "OpaqueData")).is_some()
            {
                direct_apply = false;
            }
            let channel_type = audio_comp
                .and_then(|ac| child(ac, "ChannelType"))
                .and_then(|n| n.text())
                .unwrap_or("")
                .trim();
            let inner_comp = audio_comp.and_then(|ac| child(ac, "Component"));
            let display_name = inner_comp
                .and_then(|c| child(c, "DisplayName"))
                .and_then(|n| n.text())
                .unwrap_or("")
                .trim()
                .to_string();
            let match_name = child(comp_node, "FilterMatchName")
                .and_then(|n| n.text())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or(fp_match_name)
                .to_string();
            if display_name.is_empty() {
                direct_apply = false;
            }
            let (params_ok, params) = parse_component_params(inner_comp, objects);
            if !params_ok || !params.is_empty() {
                direct_apply = false;
            }
            // Premiere saves 3 entries (Stereo=1, Mono=0, 5.1=2) for a single audio effect preset.
            // Keep the first (or Stereo) entry per display name so we don't apply duplicates.
            if channel_type == "1" || seen_audio_names.insert(display_name.clone()) {
                seen_audio_names.insert(display_name.clone());
                if let Some(existing) = filters
                    .iter_mut()
                    .find(|f| f.kind == "audio" && f.name == display_name)
                {
                    if channel_type == "1" {
                        existing.match_name = match_name;
                        existing.params = params;
                    }
                } else {
                    filters.push(PresetFilter {
                        kind: "audio".to_string(),
                        name: display_name,
                        match_name,
                        params,
                    });
                }
            }
        } else {
            direct_apply = false;
        }
    }

    if filters.is_empty() {
        direct_apply = false;
    }
    if !direct_apply {
        filters.clear();
    }
    (direct_apply, filters)
}

fn parse_component_params<'a, 'input>(
    comp: Option<Node<'a, 'input>>,
    objects: &HashMap<&'a str, Node<'a, 'input>>,
) -> (bool, Vec<PresetParam>) {
    let Some(comp) = comp else {
        return (true, Vec::new());
    };
    let Some(params_node) = child(comp, "Params") else {
        return (true, Vec::new());
    };
    let mut params = Vec::new();
    for (idx, param_item) in params_node
        .children()
        .filter(|n| n.has_tag_name("Param"))
        .enumerate()
    {
        let index = param_item
            .attribute("Index")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(idx);
        let Some(param_ref) = param_item.attribute("ObjectRef") else {
            return (false, Vec::new());
        };
        let Some(&param_node) = objects.get(param_ref) else {
            return (false, Vec::new());
        };

        let is_time_varying = child(param_node, "IsTimeVarying")
            .and_then(|n| n.text())
            .map(|t| t.trim() == "true")
            .unwrap_or(false);
        let has_keyframes = child(param_node, "Keyframes")
            .and_then(|n| n.text())
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false);
        let keyframe_set_size = child(param_node, "KeyframeSetSize")
            .and_then(|n| n.text())
            .and_then(|t| t.trim().parse::<usize>().ok())
            .unwrap_or(0);

        if is_time_varying || has_keyframes || keyframe_set_size > 0 {
            return (false, Vec::new());
        }

        if param_node.has_tag_name("ArbVideoComponentParam") {
            return (false, Vec::new());
        }

        let name = child(param_node, "Name")
            .and_then(|n| n.text())
            .unwrap_or("")
            .trim()
            .to_string();
        let control_type = child(param_node, "ParameterControlType")
            .and_then(|n| n.text())
            .and_then(|t| t.trim().parse::<u32>().ok());
        let start_kf = child(param_node, "StartKeyframe")
            .and_then(|n| n.text())
            .unwrap_or("")
            .trim();

        if !start_kf.is_empty() {
            if let Some(value) =
                parse_start_keyframe_value(param_node.tag_name().name(), control_type, start_kf)
            {
                params.push(PresetParam { index, name, value });
            } else {
                return (false, Vec::new());
            }
        }
    }
    (true, params)
}

fn parse_start_keyframe_value(
    tag: &str,
    control_type: Option<u32>,
    start_kf: &str,
) -> Option<PresetParamValue> {
    let raw = start_kf.split(',').nth(1)?.trim();
    if raw.is_empty() {
        return None;
    }
    if tag == "PointComponentParam" || control_type == Some(6) {
        let (x_str, y_str) = raw.split_once(':')?;
        let x = x_str.trim().parse::<f64>().ok()?;
        let y = y_str.trim().parse::<f64>().ok()?;
        return Some(PresetParamValue::Point { x, y });
    }
    if control_type == Some(5) {
        let packed = raw.parse::<u64>().ok()?;
        let a8 = ((packed >> 56) & 0xff) as f64 / 255.0;
        let r8 = ((packed >> 40) & 0xff) as f64 / 255.0;
        let g8 = ((packed >> 24) & 0xff) as f64 / 255.0;
        let b8 = ((packed >> 8) & 0xff) as f64 / 255.0;
        return Some(PresetParamValue::Color {
            red: r8,
            green: g8,
            blue: b8,
            alpha: a8,
        });
    }
    if raw == "true" {
        return Some(PresetParamValue::Boolean { value: true });
    }
    if raw == "false" {
        return Some(PresetParamValue::Boolean { value: false });
    }
    let value = raw.parse::<f64>().ok()?;
    Some(PresetParamValue::Number { value })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_preset_library_creation_update_and_removal() {
        let documents = std::env::temp_dir().join(format!("helm-presets-{}", uuid::Uuid::new_v4()));
        let profile = documents.join("Adobe/Premiere Pro/26.0/Profile-Test");
        let path = profile.join(LIBRARY_NAME);
        let library = PresetLibrary::default();

        assert!(!library.has_changed(&documents));
        fs::create_dir_all(&profile).unwrap();
        fs::write(&path, "<PremiereData/>").unwrap();
        assert!(library.has_changed(&documents));
        library.load(&documents, false).unwrap();
        assert!(!library.has_changed(&documents));

        fs::write(&path, "<PremiereData></PremiereData>").unwrap();
        assert!(library.has_changed(&documents));
        library.load(&documents, false).unwrap();
        fs::remove_file(path).unwrap();
        assert!(library.has_changed(&documents));
        library.load(&documents, false).unwrap();
        assert!(!library.has_changed(&documents));
        fs::remove_dir_all(documents).unwrap();
    }

    #[test]
    fn parses_static_and_keyframed_presets() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<PremiereData Version="3">
    <BinTreeItem ObjectID="1">
        <TreeItemBase Version="4"><Name>Presets</Name></TreeItemBase>
        <Items Version="1">
            <Item Index="0" ObjectRef="2"/>
            <Item Index="1" ObjectRef="10"/>
            <Item Index="2" ObjectRef="20"/>
        </Items>
        <HandlerEffects.EffectItemTree.PresetsBin Version="1"/>
    </BinTreeItem>
    <TreeItem ObjectID="2">
        <TreeItemBase Version="4">
            <Name>Black &amp; White</Name>
            <Data ObjectRef="3"/>
        </TreeItemBase>
    </TreeItem>
    <FilterPresetItem ObjectID="3">
        <FilterPresets Version="1">
            <FilterPreset Index="0" ObjectRef="4"/>
        </FilterPresets>
    </FilterPresetItem>
    <FilterPreset ObjectID="4">
        <Component ObjectRef="5"/>
        <FilterMatchName>AE.ADBE Black &amp; White</FilterMatchName>
        <TransitionDuration>0</TransitionDuration>
    </FilterPreset>
    <VideoFilterComponent ObjectID="5">
        <Component Version="7">
            <DisplayName>Black &amp; White</DisplayName>
        </Component>
        <MatchName>AE.ADBE Black &amp; White</MatchName>
    </VideoFilterComponent>
    <TreeItem ObjectID="10">
        <TreeItemBase Version="4">
            <Name>1. Zoom IN</Name>
            <Data ObjectRef="11"/>
        </TreeItemBase>
    </TreeItem>
    <FilterPresetItem ObjectID="11">
        <FilterPresets Version="1">
            <FilterPreset Index="0" ObjectRef="12"/>
        </FilterPresets>
    </FilterPresetItem>
    <FilterPreset ObjectID="12">
        <Component ObjectRef="13"/>
        <FilterMatchName>AE.ADBE Geometry2</FilterMatchName>
        <TransitionDuration>0</TransitionDuration>
    </FilterPreset>
    <VideoFilterComponent ObjectID="13">
        <Component Version="7">
            <DisplayName>Transform</DisplayName>
            <Params Version="1">
                <Param Index="0" ObjectRef="14"/>
            </Params>
        </Component>
        <MatchName>AE.ADBE Geometry2</MatchName>
    </VideoFilterComponent>
    <VideoComponentParam ObjectID="14">
        <Name>Scale Height</Name>
        <ParameterControlType>2</ParameterControlType>
        <Keyframes>0,100.,5,0,0,0.33,0,0.37;541900800000,130.,5,0,0,1,0,0.33;</Keyframes>
        <IsTimeVarying>true</IsTimeVarying>
        <StartKeyframe>-91445760000000000,100.,0,0,0,0,0,0</StartKeyframe>
    </VideoComponentParam>
    <TreeItem ObjectID="20">
        <TreeItemBase Version="4">
            <Name>Pixelated</Name>
            <Data ObjectRef="21"/>
        </TreeItemBase>
    </TreeItem>
    <FilterPresetItem ObjectID="21">
        <FilterPresets Version="1">
            <FilterPreset Index="0" ObjectRef="22"/>
        </FilterPresets>
    </FilterPresetItem>
    <FilterPreset ObjectID="22">
        <Component ObjectRef="23"/>
        <FilterMatchName>AE.ADBE Mosaic</FilterMatchName>
        <TransitionDuration>0</TransitionDuration>
    </FilterPreset>
    <VideoFilterComponent ObjectID="23">
        <Component Version="7">
            <DisplayName>Mosaic (Legacy)</DisplayName>
            <Params Version="1">
                <Param Index="0" ObjectRef="24"/>
            </Params>
        </Component>
        <MatchName>AE.ADBE Mosaic</MatchName>
    </VideoFilterComponent>
    <VideoComponentParam ObjectID="24">
        <Name>Horizontal Blocks</Name>
        <ParameterControlType>1</ParameterControlType>
        <Keyframes></Keyframes>
        <IsTimeVarying>false</IsTimeVarying>
        <StartKeyframe>-91445760000000000,75,0,0,0,0,0,0</StartKeyframe>
    </VideoComponentParam>
</PremiereData>"#;

        let presets = parse_library(xml).expect("parse preset library");
        assert_eq!(presets.len(), 3);

        let bw = &presets[0];
        assert_eq!(bw.name, "Black & White");
        assert!(bw.direct_apply);
        assert_eq!(bw.filters.len(), 1);
        assert_eq!(bw.filters[0].match_name, "AE.ADBE Black & White");
        assert_eq!(bw.filters[0].kind, "video");

        let zoom = &presets[1];
        assert_eq!(zoom.name, "1. Zoom IN");
        assert!(!zoom.direct_apply);
        assert!(zoom.filters.is_empty());

        let pix = &presets[2];
        assert_eq!(pix.name, "Pixelated");
        assert!(!pix.direct_apply);
        assert!(pix.filters.is_empty());
    }
}
