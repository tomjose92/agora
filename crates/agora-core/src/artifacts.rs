//! Validation for agent-authored structured artifacts.
//!
//! Artifacts are presentation data, not executable UI configuration. The
//! server keeps a deliberately small, versioned vocabulary and stores only a
//! sanitized copy so every client sees the same safe payload.

use std::collections::HashSet;

use serde_json::{json, Map, Value};

pub const MAX_ARTIFACTS: usize = 3;
pub const MAX_ARTIFACT_BYTES: usize = 256 * 1024;
pub const MAX_MAP_PLACES: usize = 100;
pub const MAX_MAP_REGIONS: usize = 25;
pub const MAX_MAP_DAYS: usize = 30;
pub const MAX_MAP_ROUTES: usize = 10;
pub const MAX_MAP_ROUTE_COORDINATES: usize = 500;

const MAX_LABEL_CHARS: usize = 120;
const MAX_DESCRIPTION_CHARS: usize = 2_000;

fn clean_id(value: &Value) -> Option<String> {
    let id = value.as_str()?.trim();
    (!id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
    .then(|| id.to_string())
}

fn clipped(value: &Value, max: usize) -> Option<String> {
    let text: String = value.as_str()?.trim().chars().take(max).collect();
    (!text.is_empty()).then_some(text)
}

fn position(value: &Value) -> Option<Value> {
    let lat = value["lat"].as_f64()?;
    let lng = value["lng"].as_f64()?;
    (lat.is_finite()
        && lng.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lng))
    .then(|| json!({"lat": lat, "lng": lng}))
}

fn string_ids(value: &Value, known: &HashSet<String>, cap: usize) -> Vec<Value> {
    let mut seen = HashSet::new();
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(clean_id)
        .filter(|id| known.contains(id) && seen.insert(id.clone()))
        .take(cap)
        .map(Value::String)
        .collect()
}

fn optional_text(target: &mut Map<String, Value>, key: &str, value: &Value, max: usize) {
    if let Some(text) = clipped(value, max) {
        target.insert(key.to_string(), json!(text));
    }
}

fn sanitize_map(artifact: &Value) -> Option<Value> {
    let data = artifact.get("data")?.as_object()?;

    let mut regions = Vec::new();
    let mut region_ids = HashSet::new();
    for region in data
        .get("regions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if regions.len() == MAX_MAP_REGIONS {
            break;
        }
        let Some(id) = clean_id(&region["id"]) else {
            continue;
        };
        let Some(label) = clipped(&region["label"], MAX_LABEL_CHARS) else {
            continue;
        };
        let Some(center) = position(&region["center"]) else {
            continue;
        };
        if !region_ids.insert(id.clone()) {
            continue;
        }
        regions.push(json!({"id": id, "label": label, "center": center}));
    }

    // Days only retain references to already-valid regions. Their place
    // references are added after places have been sanitized.
    let mut days = Vec::new();
    let mut day_ids = HashSet::new();
    for day in data
        .get("days")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if days.len() == MAX_MAP_DAYS {
            break;
        }
        let Some(id) = clean_id(&day["id"]) else {
            continue;
        };
        let Some(label) = clipped(&day["label"], MAX_LABEL_CHARS) else {
            continue;
        };
        if !day_ids.insert(id.clone()) {
            continue;
        }
        let mut out = json!({
            "id": id,
            "number": day["number"].as_u64().filter(|n| *n > 0 && *n <= 365).unwrap_or(1),
            "label": label,
        });
        if let Some(region_id) = clean_id(&day["region_id"]).filter(|id| region_ids.contains(id)) {
            out["region_id"] = json!(region_id);
        }
        days.push(out);
    }

    let categories = [
        "sight",
        "food",
        "hotel",
        "activity",
        "transport",
        "shopping",
        "nature",
        "other",
    ];
    let mut places = Vec::new();
    let mut place_ids = HashSet::new();
    for place in data
        .get("places")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if places.len() == MAX_MAP_PLACES {
            break;
        }
        let Some(id) = clean_id(&place["id"]) else {
            continue;
        };
        let Some(label) = clipped(&place["label"], MAX_LABEL_CHARS) else {
            continue;
        };
        let Some(pos) = position(&place["position"]) else {
            continue;
        };
        if !place_ids.insert(id.clone()) {
            continue;
        }
        let category = place["category"]
            .as_str()
            .filter(|c| categories.contains(c))
            .unwrap_or("other");
        let mut out = Map::from_iter([
            ("id".into(), json!(id)),
            ("label".into(), json!(label)),
            ("position".into(), pos),
            ("category".into(), json!(category)),
            (
                "day_ids".into(),
                Value::Array(string_ids(&place["day_ids"], &day_ids, MAX_MAP_DAYS)),
            ),
        ]);
        if let Some(region_id) = clean_id(&place["region_id"]).filter(|id| region_ids.contains(id))
        {
            out.insert("region_id".into(), json!(region_id));
        }
        if let Some(order) = place["order"].as_u64().filter(|n| *n <= 1_000) {
            out.insert("order".into(), json!(order));
        }
        if let Some(minutes) = place["duration_minutes"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 10_080)
        {
            out.insert("duration_minutes".into(), json!(minutes));
        }
        optional_text(
            &mut out,
            "description",
            &place["description"],
            MAX_DESCRIPTION_CHARS,
        );
        optional_text(&mut out, "start_time", &place["start_time"], 20);
        if let Some(place_id) = clipped(&place["google_place_id"], 256).filter(|id| {
            id.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        }) {
            out.insert("google_place_id".into(), json!(place_id));
        }
        places.push(Value::Object(out));
    }

    // Add resolved place references to each day.
    for out in &mut days {
        let id = out["id"].as_str().unwrap_or_default();
        let source = data
            .get("days")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|day| day["id"].as_str().map(str::trim) == Some(id));
        out["place_ids"] = Value::Array(
            source
                .map(|day| string_ids(&day["place_ids"], &place_ids, MAX_MAP_PLACES))
                .unwrap_or_default(),
        );
    }

    let mut routes = Vec::new();
    let mut route_ids = HashSet::new();
    let mut coordinate_count = 0;
    for route in data
        .get("routes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if routes.len() == MAX_MAP_ROUTES || coordinate_count == MAX_MAP_ROUTE_COORDINATES {
            break;
        }
        let Some(id) = clean_id(&route["id"]) else {
            continue;
        };
        if !route_ids.insert(id.clone()) {
            continue;
        }
        let kind = match route["kind"].as_str() {
            Some("day") => "day",
            _ => "overview",
        };
        let mut coordinates = Vec::new();
        for coordinate in route["coordinates"].as_array().into_iter().flatten() {
            if coordinate_count == MAX_MAP_ROUTE_COORDINATES {
                break;
            }
            let Some(pair) = coordinate.as_array().filter(|pair| pair.len() == 2) else {
                continue;
            };
            let (Some(lng), Some(lat)) = (pair[0].as_f64(), pair[1].as_f64()) else {
                continue;
            };
            if lng.is_finite()
                && lat.is_finite()
                && (-180.0..=180.0).contains(&lng)
                && (-90.0..=90.0).contains(&lat)
            {
                coordinates.push(json!([lng, lat]));
                coordinate_count += 1;
            }
        }
        let mut out = json!({
            "id": id,
            "kind": kind,
            "place_ids": string_ids(&route["place_ids"], &place_ids, MAX_MAP_PLACES),
            "region_ids": string_ids(&route["region_ids"], &region_ids, MAX_MAP_REGIONS),
            "coordinates": coordinates,
        });
        if let Some(label) = clipped(&route["label"], MAX_LABEL_CHARS) {
            out["label"] = json!(label);
        }
        routes.push(out);
    }

    if places.is_empty() && regions.is_empty() {
        return None;
    }

    // Region day_ids are derived from sanitized days, preventing stale or
    // contradictory references in agent output.
    for region in &mut regions {
        let id = region["id"].as_str().unwrap_or_default();
        region["day_ids"] = Value::Array(
            days.iter()
                .filter(|d| d["region_id"].as_str() == Some(id))
                .filter_map(|d| d["id"].as_str())
                .map(|id| json!(id))
                .collect(),
        );
    }

    Some(json!({
        "initial_view": {"mode": "fit"},
        "regions": regions,
        "days": days,
        "places": places,
        "routes": routes,
    }))
}

/// Sanitize a post frame's `artifacts` array. Unsupported artifact types and
/// versions are retained as envelopes without data so older/newer clients can
/// explain that they cannot render them; malformed known artifacts are dropped.
pub fn sanitize_artifacts(value: &Value) -> Option<Value> {
    if serde_json::to_vec(value).ok()?.len() > MAX_ARTIFACT_BYTES {
        return None;
    }
    let mut artifacts = Vec::new();
    let mut seen = HashSet::new();
    for artifact in value.as_array()?.iter().take(MAX_ARTIFACTS) {
        let Some(id) = clean_id(&artifact["id"]) else {
            continue;
        };
        let Some(kind) = clean_id(&artifact["type"]) else {
            continue;
        };
        let Some(title) = clipped(&artifact["title"], MAX_LABEL_CHARS) else {
            continue;
        };
        let version = artifact["version"].as_u64().unwrap_or(0);
        if !seen.insert(id.clone()) {
            continue;
        }
        let mut out = json!({
            "id": id,
            "type": kind,
            "version": version,
            "title": title,
        });
        if let Some(summary) = clipped(&artifact["summary"], MAX_LABEL_CHARS) {
            out["summary"] = json!(summary);
        }
        if kind == "map" && version == 1 {
            let Some(data) = sanitize_map(artifact) else {
                continue;
            };
            out["data"] = data;
        } else {
            out["unsupported"] = json!(true);
        }
        artifacts.push(out);
    }
    (!artifacts.is_empty()).then(|| Value::Array(artifacts))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map_artifact() -> Value {
        json!([{
            "id": "turkey-7-days",
            "type": "map",
            "version": 1,
            "title": "Turkey · 7 days",
            "data": {
                "regions": [{"id": "istanbul", "label": "Istanbul",
                    "center": {"lat": 41.0082, "lng": 28.9784}}],
                "days": [{"id": "day-1", "number": 1, "label": "Old city",
                    "region_id": "istanbul", "place_ids": ["hagia"]}],
                "places": [{"id": "hagia", "label": "Hagia Sophia",
                    "position": {"lat": 41.0086, "lng": 28.9802},
                    "region_id": "istanbul", "day_ids": ["day-1"], "category": "sight"}],
                "routes": [{"id": "r1", "kind": "overview",
                    "region_ids": ["istanbul"], "coordinates": [[28.9784, 41.0082]]}]
            }
        }])
    }

    #[test]
    fn valid_map_is_normalized() {
        let artifacts = sanitize_artifacts(&map_artifact()).unwrap();
        let map = &artifacts[0];
        assert_eq!(map["type"], "map");
        assert_eq!(map["data"]["places"][0]["category"], "sight");
        assert_eq!(map["data"]["regions"][0]["day_ids"][0], "day-1");
        assert_eq!(map["data"]["days"][0]["place_ids"][0], "hagia");
    }

    #[test]
    fn bad_entries_and_references_are_removed() {
        let mut source = map_artifact();
        source[0]["data"]["places"][0]["position"]["lat"] = json!(200);
        assert!(sanitize_artifacts(&source).is_some());
        let map = &sanitize_artifacts(&source).unwrap()[0];
        assert!(map["data"]["places"].as_array().unwrap().is_empty());
        assert_eq!(map["data"]["regions"].as_array().unwrap().len(), 1);
        assert!(map["data"]["days"][0]["place_ids"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn malformed_known_artifacts_drop_but_unknown_versions_survive() {
        assert!(sanitize_artifacts(&json!([{
            "id": "bad", "type": "map", "version": 1, "title": "Bad", "data": {}
        }]))
        .is_none());
        let unknown = sanitize_artifacts(&json!([{
            "id": "future", "type": "timeline", "version": 2, "title": "Future", "data": {"x": 1}
        }]))
        .unwrap();
        assert_eq!(unknown[0]["unsupported"], true);
        assert!(unknown[0].get("data").is_none());
    }

    #[test]
    fn oversized_payload_is_dropped() {
        let huge = json!([{
            "id": "huge", "type": "map", "version": 1, "title": "Huge",
            "data": {"padding": "x".repeat(MAX_ARTIFACT_BYTES)}
        }]);
        assert!(sanitize_artifacts(&huge).is_none());
    }
}
