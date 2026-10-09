package e2e

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"time"

	"github.com/opennavo/opennavo/server/seeds"
)

func fixtureHash(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func fixturePNG(width, height int, light bool) ([]byte, error) {
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	background, bar := color.RGBA{22, 26, 36, 255}, color.RGBA{79, 118, 196, 255}
	if light {
		background = color.RGBA{232, 237, 245, 255}
	}
	draw.Draw(canvas, canvas.Bounds(), image.NewUniform(background), image.Point{}, draw.Src)
	for row := 1; row <= 6; row++ {
		bounds := image.Rect(width/8, row*height/9, width*(8-row%3)/10, row*height/9+height/40)
		draw.Draw(canvas, bounds, image.NewUniform(bar), image.Point{}, draw.Src)
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, canvas); err != nil {
		return nil, fmt.Errorf("encode e2e image: %w", err)
	}
	return encoded.Bytes(), nil
}

func (s *Service) prepareMedia(ctx context.Context, data *seeds.E2EData) error {
	for index := range data.Packages {
		p := &data.Packages[index]
		payload := []byte("OpenNavo E2E fixture only; not an installable package.\n" + p.Kind + "/" + p.Token + " " + p.Version + "\n")
		key := "desktop/e2e/packages/" + p.Kind + "/" + p.Token + ".txt"
		if err := s.Objects.Put(ctx, key, payload, "text/plain"); err != nil {
			return fmt.Errorf("store e2e download: %w", err)
		}
		p.DownloadURL, p.DownloadSize, p.SHA256 = s.Objects.URL(key), int64(len(payload)), fixtureHash(payload)
		folder := "Formula"
		if p.Kind == "cask" {
			folder = "Casks"
		}
		p.SourcePath = folder + "/" + p.Token[:1] + "/" + p.Token + ".rb"
	}
	for _, spec := range []struct{ token, kind, theme string }{{"visual-studio-code", "icon", "dark"}, {"ghostty", "icon", "dark"}, {"wechat", "icon", "light"}, {"visual-studio-code", "screenshot", "dark"}, {"visual-studio-code", "screenshot", "light"}, {"new-mac", "cover", "dark"}} {
		width, height, prefix := 256, 256, "icons/e2e/"
		if spec.kind != "icon" {
			width, height, prefix = 1280, 800, "screenshots/e2e/"
		}
		body, err := fixturePNG(width, height, spec.theme == "light")
		if err != nil {
			return err
		}
		key := fmt.Sprintf("%s%s/%s-%d.png", prefix, spec.token, spec.theme, width)
		if err := s.Objects.Put(ctx, key, body, "image/png"); err != nil {
			return err
		}
		if spec.kind == "screenshot" {
			thumb, err := fixturePNG(640, 400, spec.theme == "light")
			if err != nil {
				return err
			}
			if err := s.Objects.Put(ctx, fmt.Sprintf("%s%s/%s-640.png", prefix, spec.token, spec.theme), thumb, "image/png"); err != nil {
				return err
			}
		}
		data.Media = append(data.Media, seeds.E2EAsset{Token: spec.token, Kind: spec.kind, Theme: spec.theme, Key: key, URL: s.Objects.URL(key), MIME: "image/png", Width: width, Height: height, Bytes: int64(len(body)), SHA256: fixtureHash(body), CaptionZH: "端到端测试截图（合成样本）", CaptionEN: "Synthetic end-to-end test screenshot"})
	}
	anchor := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	for index, version := range []string{"0.3.0", "0.2.2", "0.2.1", "0.2.0", "0.1.0"} {
		body := []byte("OpenNavo E2E download fixture; not an installable or signed release.\n" + version + "\n")
		key := "desktop/e2e/" + version + "/OpenNavo_E2E_fixture.dmg"
		if err := s.Objects.Put(ctx, key, body, "application/octet-stream"); err != nil {
			return err
		}
		artifacts, err := json.Marshal([]map[string]any{{"target": "dmg-universal", "url": s.Objects.URL(key), "bytes": len(body), "sha256": fixtureHash(body)}})
		if err != nil {
			return err
		}
		data.Desktop = append(data.Desktop, seeds.E2EDesktopRelease{Version: version, PubDate: anchor.Add(-time.Duration(index) * 5 * 24 * time.Hour), NotesZH: "## 测试版本 " + version + "\n\n改善浏览、搜索与更新体验。下载为不可安装的 E2E 样本。", NotesEN: "## Test release " + version + "\n\nImproved browsing, search and updates. Download is a non-installable E2E fixture.", Artifacts: artifacts})
	}
	return nil
}
