//! Shared validation for files entering the stored attachment contract.

/// Basename only, control chars stripped, bounded length.
pub(crate) fn safe_filename(name: &str) -> String {
    let base = name.replace('\\', "/");
    let base = base.rsplit('/').next().unwrap_or("").trim();
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"|?*".contains(*c))
        .take(120)
        .collect();
    if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned
    }
}

/// Image MIME from magic bytes, or None for unrecognized image data. Stored
/// MIME drives inline rendering and agent vision, so bytes outrank declarations.
pub(crate) fn sniff_image_mime(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if data.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // ISO-BMFF image brands: HEIC (iPhone default), HEIF, AVIF.
    if data.len() >= 12 && &data[4..8] == b"ftyp" {
        return match &data[8..12] {
            b"heic" | b"heix" | b"hevc" => Some("image/heic"),
            b"heif" | b"mif1" | b"msf1" => Some("image/heif"),
            b"avif" | b"avis" => Some("image/avif"),
            _ => None,
        };
    }
    None
}

/// REST uploads may carry non-images, so fall back to their declared type
/// after image sniffing. Agent image posts separately require a sniffed image.
pub(crate) fn attachment_mime(data: &[u8], declared: &str) -> String {
    sniff_image_mime(data)
        .map(str::to_string)
        .unwrap_or_else(|| declared.split(';').next().unwrap_or("").trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_recognizes_classic_web_formats() {
        assert_eq!(sniff_image_mime(b"\x89PNG\r\n\x1a\n\x00\x00"), Some("image/png"));
        assert_eq!(sniff_image_mime(b"\xff\xd8\xff\xe0rest"), Some("image/jpeg"));
        assert_eq!(sniff_image_mime(b"GIF89a......"), Some("image/gif"));
        assert_eq!(sniff_image_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some("image/webp"));
    }

    #[test]
    fn sniff_recognizes_iso_bmff_image_brands() {
        assert_eq!(sniff_image_mime(b"\x00\x00\x00\x18ftypheic\x00\x00"), Some("image/heic"));
        assert_eq!(sniff_image_mime(b"\x00\x00\x00\x18ftypmif1\x00\x00"), Some("image/heif"));
        assert_eq!(sniff_image_mime(b"\x00\x00\x00\x18ftypavif\x00\x00"), Some("image/avif"));
        assert_eq!(sniff_image_mime(b"\x00\x00\x00\x18ftypisom\x00\x00"), None);
    }

    #[test]
    fn sniff_rejects_non_images_and_short_input() {
        assert_eq!(sniff_image_mime(b"plain text"), None);
        assert_eq!(sniff_image_mime(b""), None);
        assert_eq!(sniff_image_mime(b"RIFF"), None);
    }

    #[test]
    fn attachment_mime_trusts_bytes_over_declaration() {
        assert_eq!(attachment_mime(
            b"\x00\x00\x00\x18ftypheic\x00\x00", "application/octet-stream"), "image/heic");
        assert_eq!(attachment_mime(b"\xff\xd8\xff\xe0rest", "image/png"), "image/jpeg");
        assert_eq!(attachment_mime(
            b"%PDF-1.7", "application/pdf; name=x"), "application/pdf");
    }
}
