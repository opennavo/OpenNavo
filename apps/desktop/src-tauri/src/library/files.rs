use crate::{AppError, db::Database};
use rusqlite::{OptionalExtension, params};
use sha1::{Digest, Sha1};
use std::{
    collections::HashSet,
    io::Read,
    path::{Path, PathBuf},
};
fn failure(message: &str) -> AppError {
    AppError::new("E_UNKNOWN", message)
}
pub fn mtime(path: &Path) -> Result<i64, AppError> {
    Ok(std::fs::metadata(path)?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| failure("mtime"))?
        .as_millis()
        .min(i64::MAX as u128) as i64)
}
pub fn plist(path: &Path) -> Result<plist::Dictionary, AppError> {
    let path = path.join("Contents/Info.plist");
    if std::fs::metadata(&path)?.len() > 4 * 1024 * 1024 {
        return Err(failure("plist_too_large"));
    }
    let value =
        plist::Value::from_file(path).map_err(|e| failure("plist").with_detail(e.to_string()))?;
    value
        .into_dictionary()
        .ok_or_else(|| failure("plist_dictionary"))
}
pub fn actual_version(path: &Path) -> Option<String> {
    let dict = plist(path).ok()?;
    ["CFBundleShortVersionString", "CFBundleVersion"]
        .iter()
        .find_map(|key| {
            dict.get(key)
                .and_then(plist::Value::as_string)
                .filter(|v| !v.trim().is_empty())
                .map(str::to_owned)
        })
}
pub fn cached_size(database: &Database, path: &Path) -> Result<Option<u64>, AppError> {
    let time = mtime(path)?;
    database.with(|c| {
        let result: Option<i64> = c
            .query_row(
                "SELECT bytes FROM size_cache WHERE path=?1 AND mtime=?2",
                params![path.to_string_lossy(), time],
                |r| r.get(0),
            )
            .optional()?;
        Ok(result.and_then(|v| v.try_into().ok()))
    })
}
pub fn directory_size(path: &Path) -> Result<u64, AppError> {
    let mut stack = vec![path.to_owned()];
    let mut bytes = 0u64;
    let mut count = 0u32;
    let mut directories = HashSet::new();
    while let Some(path) = stack.pop() {
        let meta = std::fs::symlink_metadata(&path)?;
        count += 1;
        if count > 2_000_000 {
            return Err(failure("size_file_limit"));
        }
        if meta.is_symlink() {
            continue;
        }
        if meta.is_file() {
            bytes = bytes.saturating_add(meta.len());
        } else if meta.is_dir() {
            if !directories.insert(path.clone()) {
                continue;
            }
            for entry in std::fs::read_dir(path)? {
                stack.push(entry?.path());
            }
        }
    }
    Ok(bytes)
}
pub fn size(database: &Database, path: &Path) -> Result<u64, AppError> {
    if let Some(size) = cached_size(database, path)? {
        return Ok(size);
    }
    let before = mtime(path)?;
    let bytes = directory_size(path)?;
    if mtime(path)? == before {
        let integer = i64::try_from(bytes).map_err(|_| failure("size_range"))?;
        database.with(|c|{c.execute("INSERT INTO size_cache(path,mtime,bytes) VALUES(?1,?2,?3) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime,bytes=excluded.bytes",params![path.to_string_lossy(),before,integer])?;Ok(())})?;
    }
    Ok(bytes)
}
pub fn cached_icon(database: &Database, path: &Path) -> Result<Option<String>, AppError> {
    let time = icon_mtime(path)?;
    database.with(|c| {
        let cached: Option<String> = c
            .query_row(
                "SELECT png_path FROM icon_cache WHERE app_path=?1 AND mtime=?2",
                params![path.to_string_lossy(), time],
                |r| r.get(0),
            )
            .optional()?;
        Ok(cached.filter(|p| Path::new(p).is_file()))
    })
}
fn icon_mtime(path: &Path) -> Result<i64, AppError> {
    Ok(mtime(path)?.max(mtime(&path.join("Contents/Info.plist")).unwrap_or(0)))
}
fn icns(path: &Path) -> Result<image::DynamicImage, AppError> {
    let dict = plist(path)?;
    let raw = dict
        .get("CFBundleIconFile")
        .and_then(plist::Value::as_string)
        .ok_or_else(|| failure("icon_missing"))?;
    if raw.contains(['/', '\\']) || raw == "." || raw == ".." {
        return Err(failure("icon_name"));
    }
    let name = if raw.ends_with(".icns") {
        raw.into()
    } else {
        format!("{raw}.icns")
    };
    let path = path.join("Contents/Resources").join(name);
    let bytes = std::fs::File::open(path)?.take(32 * 1024 * 1024);
    let family = icns::IconFamily::read(bytes)?;
    let mut types = family.available_icons();
    types.retain(|kind| kind.pixel_width() <= 512 && kind.pixel_height() <= 512);
    types.sort_by_key(|kind| std::cmp::Reverse(kind.pixel_width()));
    for kind in types {
        if let Ok(icon) = family.get_icon_with_type(kind) {
            let rgba = icon.convert_to(icns::PixelFormat::RGBA);
            if let Some(buffer) =
                image::RgbaImage::from_raw(rgba.width(), rgba.height(), rgba.data().to_vec())
            {
                return Ok(image::DynamicImage::ImageRgba8(buffer));
            }
        }
    }
    Err(failure("icon_decode"))
}
#[cfg(target_os = "macos")]
fn workspace_icon(path: &Path) -> Result<image::DynamicImage, AppError> {
    objc2::rc::autoreleasepool(|_| {
        let workspace = objc2_app_kit::NSWorkspace::sharedWorkspace();
        let image = workspace.iconForFile(&objc2_foundation::NSString::from_str(
            &path.to_string_lossy(),
        ));
        image.setSize(objc2_foundation::NSSize::new(512.0, 512.0));
        use objc2::AnyThread;
        use objc2_app_kit::{
            NSBitmapFormat, NSBitmapImageRep, NSCompositingOperation, NSDeviceRGBColorSpace,
            NSGraphicsContext,
        };
        let rect = objc2_foundation::NSRect::new(
            objc2_foundation::NSPoint::new(0.0, 0.0),
            objc2_foundation::NSSize::new(512.0, 512.0),
        );
        // Empty planes lets AppKit allocate; use fixed 8-bit RGBA to avoid system HDR icons' 16-bit float TIFFs.
        let bitmap=unsafe{NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bitmapFormat_bytesPerRow_bitsPerPixel(NSBitmapImageRep::alloc(),std::ptr::null_mut(),512,512,8,4,true,false,NSDeviceRGBColorSpace,NSBitmapFormat::empty(),2048,32)}.ok_or_else(||failure("workspace_bitmap"))?;
        let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap)
            .ok_or_else(|| failure("workspace_context"))?;
        NSGraphicsContext::saveGraphicsState_class();
        struct Restore;
        impl Drop for Restore {
            fn drop(&mut self) {
                NSGraphicsContext::restoreGraphicsState_class();
            }
        }
        let _restore = Restore;
        NSGraphicsContext::setCurrentContext(Some(&context));
        image.drawInRect_fromRect_operation_fraction(rect, rect, NSCompositingOperation::Copy, 1.0);
        let data = bitmap
            .TIFFRepresentation()
            .ok_or_else(|| failure("workspace_icon"))?;
        if data.length() > 32 * 1024 * 1024 {
            return Err(failure("workspace_icon_size"));
        }
        image::load_from_memory(&data.to_vec())
            .map_err(|e| failure("workspace_icon_decode").with_detail(e.to_string()))
    })
}
#[cfg(not(target_os = "macos"))]
fn workspace_icon(_path: &Path) -> Result<image::DynamicImage, AppError> {
    Err(failure("workspace_icon_unsupported"))
}
pub fn icon(database: &Database, path: &Path, cache: &Path) -> Result<String, AppError> {
    if let Some(cached) = cached_icon(database, path)? {
        return Ok(cached);
    }
    let time = icon_mtime(path)?;
    let decoded = icns(path).or_else(|_| workspace_icon(path))?;
    let decoded = if decoded.width() > 512 || decoded.height() > 512 {
        decoded.thumbnail(512, 512)
    } else {
        decoded
    };
    std::fs::create_dir_all(cache)?;
    let hash = format!("{:x}", Sha1::digest(path.to_string_lossy().as_bytes()));
    let destination = cache.join(format!("{hash}-{time}.png"));
    let temporary = cache.join(format!("icon_{}.tmp", uuid::Uuid::now_v7()));
    let result = (|| {
        let mut file = std::fs::File::create(&temporary)?;
        decoded
            .write_to(&mut file, image::ImageFormat::Png)
            .map_err(|e| failure("icon_png").with_detail(e.to_string()))?;
        std::fs::rename(&temporary, &destination)?;
        Ok::<_, AppError>(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result?;
    let png = destination.to_string_lossy().into_owned();
    database.with(|c|{c.execute("INSERT INTO icon_cache(app_path,mtime,png_path) VALUES(?1,?2,?3) ON CONFLICT(app_path) DO UPDATE SET mtime=excluded.mtime,png_path=excluded.png_path",params![path.to_string_lossy(),time,png])?;Ok(())})?;
    Ok(png)
}
pub fn formula_path(prefix: &str, token: &str, version: &str) -> Option<PathBuf> {
    if crate::brew::args::validate_token(token).is_err()
        || version.contains(['/', '\\'])
        || version.is_empty()
        || version == "."
        || version == ".."
    {
        return None;
    }
    Some(Path::new(prefix).join("Cellar").join(token).join(version))
}
