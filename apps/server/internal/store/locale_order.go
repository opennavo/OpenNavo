package store

// The IN clause restricts candidates to requested, English and source languages; shared precedence prevents query drift.
const localeFallbackTail = " THEN 0 WHEN 'en-US' THEN 1 ELSE 2 END"
const publicLocaleOrder = "CASE t.locale WHEN lang.requested" + localeFallbackTail
const adminLocaleOrder = "CASE t.locale WHEN @onv_locale" + localeFallbackTail
const announcementLocaleOrder = "CASE locale WHEN ?" + localeFallbackTail
