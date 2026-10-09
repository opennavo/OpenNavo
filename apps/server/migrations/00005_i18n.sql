-- +goose Up

-- Copy and validate old text before dropping fixed bilingual columns; roll back everything if the transaction fails.

ALTER TABLE packages ADD COLUMN source_locale TEXT NOT NULL DEFAULT 'en-US' CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU'));

ALTER TABLE releases ADD COLUMN source_locale TEXT NOT NULL DEFAULT 'en-US' CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU'));

ALTER TABLE categories ADD COLUMN source_locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU'));

ALTER TABLE collections ADD COLUMN source_locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU'));

ALTER TABLE features ADD COLUMN source_locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU'));

ALTER TABLE package_screenshots ADD COLUMN source_locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU'));

ALTER TABLE collection_items ADD COLUMN source_locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU'));

ALTER TABLE desktop_releases ADD COLUMN source_locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU'));

ALTER TABLE mirrors ADD COLUMN source_locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU'));

ALTER TABLE package_i18n DROP CONSTRAINT package_i18n_locale_check;

ALTER TABLE package_i18n ADD CHECK (locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU'));

ALTER TABLE package_i18n ADD COLUMN source_locale TEXT NOT NULL DEFAULT 'en-US' CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU')), ADD COLUMN translated_at TIMESTAMPTZ;

ALTER TABLE package_i18n DROP CONSTRAINT package_i18n_status_check;

UPDATE package_i18n SET status=CASE WHEN locale='en-US' THEN 'source' WHEN status='reviewed' THEN 'manual' WHEN status='needs_review' THEN 'machine' ELSE status END, translated_at=CASE WHEN locale<>'en-US' AND status IN ('machine','needs_review','reviewed') THEN updated_at END;

ALTER TABLE package_i18n ADD CHECK (status IN ('source','machine','manual','pending','failed'));

ALTER TABLE release_i18n DROP CONSTRAINT release_i18n_locale_check;

ALTER TABLE release_i18n ADD CHECK (locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU'));

ALTER TABLE release_i18n ADD COLUMN source_locale TEXT NOT NULL DEFAULT 'en-US' CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU')), ADD COLUMN translated_at TIMESTAMPTZ;

ALTER TABLE release_i18n DROP CONSTRAINT release_i18n_status_check;

UPDATE release_i18n SET status=CASE WHEN locale='en-US' THEN 'source' WHEN status='reviewed' THEN 'manual' WHEN status='needs_review' THEN 'machine' ELSE status END, translated_at=CASE WHEN locale<>'en-US' AND status IN ('machine','needs_review','reviewed') THEN updated_at END;

ALTER TABLE release_i18n ADD CHECK (status IN ('source','machine','manual','pending','failed','skipped'));

ALTER TABLE category_i18n DROP CONSTRAINT category_i18n_locale_check;

ALTER TABLE category_i18n ADD CHECK (locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU'));

ALTER TABLE category_i18n ADD COLUMN source_locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU')), ADD COLUMN translated_at TIMESTAMPTZ;

ALTER TABLE category_i18n ADD COLUMN status TEXT NOT NULL DEFAULT 'manual' CHECK (status IN ('source','machine','manual','pending','failed')), ADD COLUMN source_hash TEXT, ADD COLUMN model TEXT, ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE category_i18n SET status=CASE WHEN locale='zh-CN' THEN 'source' ELSE 'manual' END;

ALTER TABLE collection_i18n DROP CONSTRAINT collection_i18n_locale_check;

ALTER TABLE collection_i18n ADD CHECK (locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU'));

ALTER TABLE collection_i18n ADD COLUMN source_locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU')), ADD COLUMN translated_at TIMESTAMPTZ;

ALTER TABLE collection_i18n ADD COLUMN status TEXT NOT NULL DEFAULT 'manual' CHECK (status IN ('source','machine','manual','pending','failed')), ADD COLUMN source_hash TEXT, ADD COLUMN model TEXT, ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE collection_i18n SET status=CASE WHEN locale='zh-CN' THEN 'source' ELSE 'manual' END;

ALTER TABLE feature_i18n DROP CONSTRAINT feature_i18n_locale_check;

ALTER TABLE feature_i18n ADD CHECK (locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU'));

ALTER TABLE feature_i18n ADD COLUMN source_locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU')), ADD COLUMN translated_at TIMESTAMPTZ;

ALTER TABLE feature_i18n ADD COLUMN status TEXT NOT NULL DEFAULT 'manual' CHECK (status IN ('source','machine','manual','pending','failed')), ADD COLUMN source_hash TEXT, ADD COLUMN model TEXT, ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE feature_i18n SET status=CASE WHEN locale='zh-CN' THEN 'source' ELSE 'manual' END;

ALTER TABLE release_i18n ADD COLUMN title TEXT;

ALTER TABLE releases DROP CONSTRAINT releases_source_check;

ALTER TABLE releases ADD CHECK (source IN ('github_release','sparkle','webpage','manual','editorial'));

DROP INDEX release_i18n_todo;

CREATE INDEX release_i18n_todo ON release_i18n(status) WHERE status IN ('pending','failed');

CREATE TABLE screenshot_i18n (screenshot_id BIGINT NOT NULL, locale TEXT NOT NULL CHECK (locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU')), caption TEXT NULL, status TEXT NOT NULL CHECK (status IN ('source','machine','manual','pending','failed')), source_locale TEXT NOT NULL CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU')), source_hash TEXT, model TEXT, translated_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (screenshot_id,locale), FOREIGN KEY (screenshot_id) REFERENCES package_screenshots(id) ON DELETE CASCADE);

INSERT INTO screenshot_i18n (screenshot_id,locale,caption,status,source_locale) SELECT id,'zh-CN',caption_zh,'source','zh-CN' FROM package_screenshots;

INSERT INTO screenshot_i18n (screenshot_id,locale,caption,status,source_locale) SELECT id,'en-US',caption_en,'manual','zh-CN' FROM package_screenshots;

ALTER TABLE package_screenshots DROP COLUMN caption_zh, DROP COLUMN caption_en;

CREATE TABLE collection_item_i18n (collection_id BIGINT NOT NULL,package_id BIGINT NOT NULL, locale TEXT NOT NULL CHECK (locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU')), note TEXT NULL, status TEXT NOT NULL CHECK (status IN ('source','machine','manual','pending','failed')), source_locale TEXT NOT NULL CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU')), source_hash TEXT, model TEXT, translated_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (collection_id,package_id,locale), FOREIGN KEY (collection_id,package_id) REFERENCES collection_items(collection_id,package_id) ON DELETE CASCADE);

INSERT INTO collection_item_i18n (collection_id,package_id,locale,note,status,source_locale) SELECT collection_id,package_id,'zh-CN',note_zh,'source','zh-CN' FROM collection_items;

INSERT INTO collection_item_i18n (collection_id,package_id,locale,note,status,source_locale) SELECT collection_id,package_id,'en-US',note_en,'manual','zh-CN' FROM collection_items;

ALTER TABLE collection_items DROP COLUMN note_zh, DROP COLUMN note_en;

CREATE TABLE desktop_release_i18n (desktop_release_id BIGINT NOT NULL, locale TEXT NOT NULL CHECK (locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU')), notes TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('source','machine','manual','pending','failed')), source_locale TEXT NOT NULL CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU')), source_hash TEXT, model TEXT, translated_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (desktop_release_id,locale), FOREIGN KEY (desktop_release_id) REFERENCES desktop_releases(id) ON DELETE CASCADE);

INSERT INTO desktop_release_i18n (desktop_release_id,locale,notes,status,source_locale) SELECT id,'zh-CN',notes_zh,'source','zh-CN' FROM desktop_releases;

INSERT INTO desktop_release_i18n (desktop_release_id,locale,notes,status,source_locale) SELECT id,'en-US',notes_en,'manual','zh-CN' FROM desktop_releases;

ALTER TABLE desktop_releases DROP COLUMN notes_zh, DROP COLUMN notes_en;

CREATE TABLE mirror_i18n (mirror_id BIGINT NOT NULL, locale TEXT NOT NULL CHECK (locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU')), name TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('source','machine','manual','pending','failed')), source_locale TEXT NOT NULL CHECK (source_locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU')), source_hash TEXT, model TEXT, translated_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (mirror_id,locale), FOREIGN KEY (mirror_id) REFERENCES mirrors(id) ON DELETE CASCADE);

INSERT INTO mirror_i18n (mirror_id,locale,name,status,source_locale) SELECT id,'zh-CN',name_zh,'source','zh-CN' FROM mirrors;

INSERT INTO mirror_i18n (mirror_id,locale,name,status,source_locale) SELECT id,'en-US',name_en,'manual','zh-CN' FROM mirrors;

ALTER TABLE mirrors DROP COLUMN name_zh, DROP COLUMN name_en;

-- Continue displaying old translations while pending/failed; provenance cannot be inferred solely from the current queue state.
-- +goose StatementBegin
CREATE FUNCTION preserve_translation_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='machine' THEN NEW.machine_translated := true;
  ELSIF NEW.status IN ('source','manual','skipped') THEN NEW.machine_translated := false;
  ELSIF TG_OP='UPDATE' THEN NEW.machine_translated := OLD.machine_translated;
  ELSE NEW.machine_translated := false;
  END IF;
  RETURN NEW;
END $$;
-- +goose StatementEnd

ALTER TABLE package_i18n ADD COLUMN machine_translated BOOLEAN NOT NULL DEFAULT false;
UPDATE package_i18n SET machine_translated=(status='machine');
CREATE TRIGGER translation_provenance BEFORE INSERT OR UPDATE OF status ON package_i18n FOR EACH ROW EXECUTE FUNCTION preserve_translation_provenance();

ALTER TABLE release_i18n ADD COLUMN machine_translated BOOLEAN NOT NULL DEFAULT false;
UPDATE release_i18n SET machine_translated=(status='machine');
CREATE TRIGGER translation_provenance BEFORE INSERT OR UPDATE OF status ON release_i18n FOR EACH ROW EXECUTE FUNCTION preserve_translation_provenance();

ALTER TABLE category_i18n ADD COLUMN machine_translated BOOLEAN NOT NULL DEFAULT false;
UPDATE category_i18n SET machine_translated=(status='machine');
CREATE TRIGGER translation_provenance BEFORE INSERT OR UPDATE OF status ON category_i18n FOR EACH ROW EXECUTE FUNCTION preserve_translation_provenance();

ALTER TABLE collection_i18n ADD COLUMN machine_translated BOOLEAN NOT NULL DEFAULT false;
UPDATE collection_i18n SET machine_translated=(status='machine');
CREATE TRIGGER translation_provenance BEFORE INSERT OR UPDATE OF status ON collection_i18n FOR EACH ROW EXECUTE FUNCTION preserve_translation_provenance();

ALTER TABLE feature_i18n ADD COLUMN machine_translated BOOLEAN NOT NULL DEFAULT false;
UPDATE feature_i18n SET machine_translated=(status='machine');
CREATE TRIGGER translation_provenance BEFORE INSERT OR UPDATE OF status ON feature_i18n FOR EACH ROW EXECUTE FUNCTION preserve_translation_provenance();

ALTER TABLE screenshot_i18n ADD COLUMN machine_translated BOOLEAN NOT NULL DEFAULT false;
UPDATE screenshot_i18n SET machine_translated=(status='machine');
CREATE TRIGGER translation_provenance BEFORE INSERT OR UPDATE OF status ON screenshot_i18n FOR EACH ROW EXECUTE FUNCTION preserve_translation_provenance();

ALTER TABLE collection_item_i18n ADD COLUMN machine_translated BOOLEAN NOT NULL DEFAULT false;
UPDATE collection_item_i18n SET machine_translated=(status='machine');
CREATE TRIGGER translation_provenance BEFORE INSERT OR UPDATE OF status ON collection_item_i18n FOR EACH ROW EXECUTE FUNCTION preserve_translation_provenance();

ALTER TABLE desktop_release_i18n ADD COLUMN machine_translated BOOLEAN NOT NULL DEFAULT false;
UPDATE desktop_release_i18n SET machine_translated=(status='machine');
CREATE TRIGGER translation_provenance BEFORE INSERT OR UPDATE OF status ON desktop_release_i18n FOR EACH ROW EXECUTE FUNCTION preserve_translation_provenance();

ALTER TABLE mirror_i18n ADD COLUMN machine_translated BOOLEAN NOT NULL DEFAULT false;
UPDATE mirror_i18n SET machine_translated=(status='machine');
CREATE TRIGGER translation_provenance BEFORE INSERT OR UPDATE OF status ON mirror_i18n FOR EACH ROW EXECUTE FUNCTION preserve_translation_provenance();

-- +goose Down

-- Downgrading after six-language writes loses content; prohibit automatic rollback.

-- +goose StatementBegin

DO $$ BEGIN RAISE EXCEPTION 'Six-language migration cannot be reversed without losing content'; END $$;

-- +goose StatementEnd
