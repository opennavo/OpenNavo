package agent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/i18n"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/redis/go-redis/v9"
)

var Grantable = []string{"dashboard:view", "catalog:package:view", "catalog:package:edit", "catalog:package:resync", "catalog:asset:upload", "catalog:category:edit", "content:collection:edit", "content:collection:publish", "content:feature:edit", "content:glossary:edit", "changelog:release:edit", "translation:review", "ops:job:view", "ops:job:trigger", "ops:search:view", "ops:search:edit", "ops:feedback:handle", "agent:log:view", "content:revision:restore", "content:announcement:edit", "release:desktop:notes"}

type Limits struct {
	CallsPerMinute int `json:"callsPerMinute"`
	WritesPerDay   int `json:"writesPerDay"`
	LLMOpsPerDay   int `json:"llmOpsPerDay"`
	BatchLimit     int `json:"batchLimit"`
}
type Identity struct {
	ID, ClientID, UserID int64
	ClientName, Prefix   string
	Permissions          []string
	AllowDelete          bool
	ExpiresAt            *time.Time
	Limits               Limits
}
type Service struct {
	Store         *store.Store
	GatewaySecret string
	Now           func() time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}
func Error(code string) error { return &domain.AppError{Code: code, HTTPStatus: 403} }
func Token() (string, string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", "", err
	}
	plain := "onv_" + base64.RawURLEncoding.EncodeToString(b[:])
	return plain, Hash(plain), nil
}
func Hash(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}
func (s *Service) Authenticate(ctx context.Context, gateway, token, ip string) (Identity, error) {
	var out Identity
	if len(s.GatewaySecret) < 32 || subtle.ConstantTimeCompare([]byte(gateway), []byte(s.GatewaySecret)) != 1 {
		return out, Error(domain.CodeForbidden)
	}
	if !strings.HasPrefix(token, "onv_") || len(token) != 47 {
		return out, Error(domain.CodeUnauthenticated)
	}
	var row struct {
		ID, ClientID, UserID                                   int64
		ClientName, TokenPrefix                                string
		Permissions, IPAllowlist                               json.RawMessage
		AllowDelete, ClientEnabled, UserEnabled, Enabled       bool
		ExpiresAt, RevokedAt                                   *time.Time
		CallsPerMinute, WritesPerDay, LLMOpsPerDay, BatchLimit int
	}
	err := s.Store.DB.WithContext(ctx).Raw(`SELECT t.id,t.client_id,c.user_id,c.name client_name,t.token_prefix,to_jsonb(t.permissions) permissions,to_jsonb(t.ip_allowlist) ip_allowlist,t.allow_delete,t.expires_at,t.revoked_at,c.enabled client_enabled,(u.status='1' AND u.is_machine) user_enabled,s.enabled,s.calls_per_minute,s.writes_per_day,s.llm_ops_per_day,s.batch_limit FROM agent_tokens t JOIN agent_clients c ON c.id=t.client_id JOIN admin_users u ON u.id=c.user_id CROSS JOIN agent_settings s WHERE t.token_hash=?`, Hash(token)).Scan(&row).Error
	if err != nil {
		return out, err
	}
	if row.ID == 0 {
		return out, Error(domain.CodeUnauthenticated)
	}
	if row.RevokedAt != nil {
		return out, Error(domain.CodeSessionInvalid)
	}
	if row.ExpiresAt != nil && !row.ExpiresAt.After(s.now()) {
		return out, Error(domain.CodeUnauthenticated)
	}
	if !row.Enabled || !row.ClientEnabled || !row.UserEnabled {
		return out, Error(domain.CodeAccountDisabled)
	}
	var permissions, allowedIPs []string
	if err := json.Unmarshal(row.Permissions, &permissions); err != nil {
		return out, err
	}
	if err := json.Unmarshal(row.IPAllowlist, &allowedIPs); err != nil {
		return out, err
	}
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return out, Error(domain.CodeForbidden)
	}
	if len(allowedIPs) > 0 {
		accepted := false
		for _, v := range allowedIPs {
			p, e := netip.ParsePrefix(v)
			if e == nil && p.Contains(addr.Unmap()) {
				accepted = true
			}
		}
		if !accepted {
			return out, Error(domain.CodeForbidden)
		}
	}
	var rolePermissions []string
	if err := s.Store.DB.WithContext(ctx).Raw(`SELECT rp.permission_code FROM admin_role_permissions rp JOIN admin_roles r ON r.id=rp.role_id JOIN admin_user_roles ur ON ur.role_id=r.id WHERE r.role_code='R_AGENT' AND ur.user_id=?`, row.UserID).Scan(&rolePermissions).Error; err != nil {
		return out, err
	}
	out = Identity{ID: row.ID, ClientID: row.ClientID, UserID: row.UserID, ClientName: row.ClientName, Prefix: row.TokenPrefix, Permissions: []string{}, AllowDelete: row.AllowDelete, ExpiresAt: row.ExpiresAt, Limits: Limits{row.CallsPerMinute, row.WritesPerDay, row.LLMOpsPerDay, row.BatchLimit}}
	for _, p := range permissions {
		if slices.Contains(Grantable, p) && slices.Contains(rolePermissions, p) {
			out.Permissions = append(out.Permissions, p)
		}
	}
	return out, nil
}

var quotaScript = redis.NewScript(`
local c=tonumber(redis.call('GET',KEYS[1]) or '0')
local w=tonumber(redis.call('GET',KEYS[2]) or '0')
local l=tonumber(redis.call('GET',KEYS[3]) or '0')
if c+1>tonumber(ARGV[1]) or w+tonumber(ARGV[4])>tonumber(ARGV[2]) or l+tonumber(ARGV[5])>tonumber(ARGV[3]) then return 0 end
redis.call('INCR',KEYS[1]);redis.call('EXPIRE',KEYS[1],tonumber(ARGV[6]))
redis.call('INCRBY',KEYS[2],ARGV[4]);redis.call('EXPIRE',KEYS[2],tonumber(ARGV[7]))
redis.call('INCRBY',KEYS[3],ARGV[5]);redis.call('EXPIRE',KEYS[3],tonumber(ARGV[7]));return 1`)

func (s *Service) quotaKeys(id int64) ([]string, time.Time, time.Time) {
	now := s.now()
	minute := now.Truncate(time.Minute).Add(time.Minute)
	day := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, time.UTC)
	base := strconv.FormatInt(id, 10)
	return []string{"agent:quota:" + base + ":minute:" + now.Format("200601021504"), "agent:quota:" + base + ":write:" + now.Format("20060102"), "agent:quota:" + base + ":llm:" + now.Format("20060102")}, minute, day
}
func (s *Service) Reserve(ctx context.Context, id Identity, write, llm int) error {
	if s.Store.Redis == nil {
		return errors.New("agent quota store unavailable")
	}
	keys, minute, day := s.quotaKeys(id.ID)
	n, err := quotaScript.Run(ctx, s.Store.Redis, keys, id.Limits.CallsPerMinute, id.Limits.WritesPerDay, id.Limits.LLMOpsPerDay, write, llm, int(time.Until(minute).Seconds())+120, int(time.Until(day).Seconds())+120).Int()
	if err != nil {
		return err
	}
	if n != 1 {
		return Error(domain.CodeRateLimited)
	}
	return nil
}
func (s *Service) Introspect(ctx context.Context, id Identity) (any, error) {
	keys, minute, day := s.quotaKeys(id.ID)
	counts := []int{0, 0, 0}
	if s.Store.Redis == nil {
		return nil, errors.New("agent quota store unavailable")
	}
	for n, k := range keys {
		v, err := s.Store.Redis.Get(ctx, k).Int()
		if err != nil && !errors.Is(err, redis.Nil) {
			return nil, err
		}
		counts[n] = v
	}
	return map[string]any{"active": true, "clientId": id.ClientID, "clientName": id.ClientName, "tokenId": id.ID, "tokenPrefix": id.Prefix, "permissions": id.Permissions, "allowDelete": id.AllowDelete, "paused": false, "limits": id.Limits, "quota": map[string]any{"callsRemaining": max(0, id.Limits.CallsPerMinute-counts[0]), "writesRemaining": max(0, id.Limits.WritesPerDay-counts[1]), "llmOpsRemaining": max(0, id.Limits.LLMOpsPerDay-counts[2]), "minuteResetsAt": minute, "dayResetsAt": day}, "locales": i18n.Locales, "expiresAt": id.ExpiresAt}, nil
}
