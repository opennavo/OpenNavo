-- +goose Up
-- Initial synonyms are editable in the admin UI and match search acceptance fixtures.
INSERT INTO search_synonyms (terms) VALUES
  (ARRAY['vscode','visual studio code','vs code','visual-studio-code']),
  (ARRAY['微信','wechat','weixin','wx']),
  (ARRAY['rg','ripgrep']),
  (ARRAY['jetbrains mono','font-jetbrains-mono']);

-- +goose Down
-- Delete only unedited initial groups; preserve manual changes.
DELETE FROM search_synonyms WHERE terms IN (
  ARRAY['vscode','visual studio code','vs code','visual-studio-code'],
  ARRAY['微信','wechat','weixin','wx'],
  ARRAY['rg','ripgrep'],
  ARRAY['jetbrains mono','font-jetbrains-mono']
);
