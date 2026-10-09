// Rasterize icons/trayTemplate.svg into menu-bar templates (22 / 44 px, black + transparent; system supplies tint).
// SVG contains flattened small-logo polygons (source: docs/design/logo/); only parse points here.
// Run: cargo run --example generate_tray_icons --manifest-path apps/desktop/src-tauri/Cargo.toml
use image::{Rgba, RgbaImage};

type Polygon = Vec<(f64, f64)>;

// Sample each pixel 8×8 times for 64 edge alpha levels.
const SAMPLES: u32 = 8;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let svg = include_str!("../icons/trayTemplate.svg");
    let view_box: f64 = regex::Regex::new(r#"viewBox="0 0 ([\d.]+) [\d.]+""#)?
        .captures(svg)
        .ok_or("tray_view_box")?[1]
        .parse()?;
    let polygons = regex::Regex::new(r#"points="([^"]+)""#)?
        .captures_iter(svg)
        .map(|captured| {
            captured[1]
                .split_whitespace()
                .map(|point| {
                    let (x, y) = point.split_once(',').ok_or("tray_point")?;
                    Ok((x.parse()?, y.parse()?))
                })
                .collect::<Result<Polygon, Box<dyn std::error::Error>>>()
        })
        .collect::<Result<Vec<_>, _>>()?;
    if polygons.is_empty() {
        return Err("tray_polygon".into());
    }
    for (size, name) in [(22, "trayTemplate.png"), (44, "trayTemplate@2x.png")] {
        let scale = view_box / size as f64;
        let mut image = RgbaImage::new(size, size);
        for y in 0..size {
            for x in 0..size {
                let mut coverage = 0;
                for sy in 0..SAMPLES {
                    for sx in 0..SAMPLES {
                        let px = (x as f64 + (sx as f64 + 0.5) / SAMPLES as f64) * scale;
                        let py = (y as f64 + (sy as f64 + 0.5) / SAMPLES as f64) * scale;
                        if polygons.iter().any(|polygon| contains(polygon, px, py)) {
                            coverage += 1;
                        }
                    }
                }
                let alpha = (coverage * 255 / (SAMPLES * SAMPLES)) as u8;
                image.put_pixel(x, y, Rgba([0, 0, 0, alpha]));
            }
        }
        image.save(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("icons")
                .join(name),
        )?;
    }
    Ok(())
}

/// Even-odd rule: a rightward ray crosses an odd number of edges inside the polygon.
fn contains(polygon: &[(f64, f64)], px: f64, py: f64) -> bool {
    let mut inside = false;
    for (index, &(ax, ay)) in polygon.iter().enumerate() {
        let (bx, by) = polygon[(index + 1) % polygon.len()];
        if (ay > py) != (by > py) && px < (bx - ax) * (py - ay) / (by - ay) + ax {
            inside = !inside;
        }
    }
    inside
}
