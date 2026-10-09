package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/service/seed"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/redis/go-redis/v9"
)

type Service struct {
	Store     *store.Store
	Config    config.Config
	Now       func() time.Time
	dummyHash string
}
type Claims struct {
	Name string `json:"name"`
	SV   int    `json:"sv"`
	Type string `json:"typ"`
	jwt.RegisteredClaims
}
type Identity struct {
	ID, RefreshID int64
	Name          string
	SV            int
	Permissions   store.PermissionSet
}

func New(st *store.Store, cfg config.Config) (*Service, error) {
	if len(cfg.JWTSecret) < 32 {
		return nil, errors.New("invalid JWT configuration")
	}
	dummy, err := seed.HashPassword(rand.Text())
	if err != nil {
		return nil, err
	}
	return &Service{Store: st, Config: cfg, dummyHash: dummy}, nil
}
func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}
func failure(code string) error { return &domain.AppError{Code: code, HTTPStatus: 401} }
func (s *Service) verify(password, hash string) bool {
	if hash == "" {
		_ = VerifyPassword(password, s.dummyHash)
		return false
	}
	return VerifyPassword(password, hash)
}
func (s *Service) session(actor store.AuditActor) (string, store.SessionInput, error) {
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		return "", store.SessionInput{}, err
	}
	family, err := uuid.NewRandom()
	if err != nil {
		return "", store.SessionInput{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(data)
	return token, store.SessionInput{Hash: hashToken(token), Family: family.String(), ExpiresAt: s.now().Add(s.Config.JWTRefreshTTL), Actor: actor}, nil
}
func (s *Service) sign(u store.AuthUser, refreshID int64) (string, error) {
	now := s.now()
	claims := Claims{Name: u.UserName, SV: u.SessionVersion, Type: "access", RegisteredClaims: jwt.RegisteredClaims{Subject: strconv.FormatInt(u.ID, 10), ID: strconv.FormatInt(refreshID, 10), IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(s.Config.JWTAccessTTL))}}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(s.Config.JWTSecret))
}
func (s *Service) Login(ctx context.Context, name, password string, actor store.AuditActor) (adminapi.LoginToken, error) {
	out := adminapi.LoginToken{}
	if name == "" || utf8.RuneCountInString(name) > 64 || password == "" || utf8.RuneCountInString(password) > 128 {
		return out, domain.Validation()
	}
	token, in, err := s.session(actor)
	if err != nil {
		return out, err
	}
	u, id, err := s.Store.LoginSession(ctx, name, s.now(), func(hash string) bool { return s.verify(password, hash) }, in)
	if err != nil {
		return out, err
	}
	access, err := s.sign(u, id)
	return adminapi.LoginToken{Token: access, RefreshToken: token}, err
}
func (s *Service) Refresh(ctx context.Context, token string, actor store.AuditActor) (adminapi.LoginToken, error) {
	out := adminapi.LoginToken{}
	data, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(data) != 32 {
		return out, failure(domain.CodeUnauthenticated)
	}
	next, in, err := s.session(actor)
	if err != nil {
		return out, err
	}
	u, id, err := s.Store.RefreshSession(ctx, hashToken(token), s.now(), in)
	if err != nil {
		return out, err
	}
	access, err := s.sign(u, id)
	return adminapi.LoginToken{Token: access, RefreshToken: next}, err
}
func (s *Service) Parse(token string) (Claims, error) {
	var claims Claims
	if len(token) > 8192 {
		return claims, failure(domain.CodeUnauthenticated)
	}
	_, err := jwt.ParseWithClaims(token, &claims, func(t *jwt.Token) (any, error) { return []byte(s.Config.JWTSecret), nil }, jwt.WithValidMethods([]string{"HS256"}), jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithTimeFunc(s.now))
	if err != nil {
		if claims.Type != "access" || claims.Subject == "" || claims.IssuedAt == nil || claims.SV < 1 {
			return claims, failure(domain.CodeUnauthenticated)
		}
		if errors.Is(err, jwt.ErrTokenExpired) && !errors.Is(err, jwt.ErrTokenSignatureInvalid) && !errors.Is(err, jwt.ErrTokenMalformed) {
			return claims, failure(domain.CodeAccessExpired)
		}
		return claims, failure(domain.CodeUnauthenticated)
	}
	if claims.Type != "access" || claims.Subject == "" || claims.IssuedAt == nil || claims.SV < 1 {
		return claims, failure(domain.CodeUnauthenticated)
	}
	return claims, nil
}
func (s *Service) Authenticate(ctx context.Context, token string) (Identity, error) {
	claims, err := s.Parse(token)
	if err != nil {
		return Identity{}, err
	}
	id, err := strconv.ParseInt(claims.Subject, 10, 64)
	if err != nil || id < 1 {
		return Identity{}, failure(domain.CodeUnauthenticated)
	}
	ref, err := strconv.ParseInt(claims.ID, 10, 64)
	if err != nil || ref < 1 {
		return Identity{}, failure(domain.CodeUnauthenticated)
	}
	u, err := s.Store.AuthUser(ctx, id)
	if err != nil {
		return Identity{}, err
	}
	if u.Status != "1" || u.IsMachine {
		return Identity{}, failure(domain.CodeAccountDisabled)
	}
	if u.SessionVersion != claims.SV {
		return Identity{}, failure(domain.CodePasswordChanged)
	}
	active, err := s.Store.SessionActive(ctx, id, ref, s.now())
	if err != nil {
		return Identity{}, err
	}
	if !active {
		return Identity{}, failure(domain.CodeUnauthenticated)
	}
	perms, err := s.permissions(ctx, u)
	return Identity{ID: id, RefreshID: ref, Name: u.UserName, SV: u.SessionVersion, Permissions: perms}, err
}
func (s *Service) permissions(ctx context.Context, u store.AuthUser) (store.PermissionSet, error) {
	key := fmt.Sprintf("admin:perm:%d:%d", u.ID, u.SessionVersion)
	if s.Store.Redis != nil {
		data, err := s.Store.Redis.Get(ctx, key).Bytes()
		if err == nil {
			var p store.PermissionSet
			if json.Unmarshal(data, &p) == nil {
				return p, nil
			}
		} else if !errors.Is(err, redis.Nil) {
			return store.PermissionSet{}, err
		}
	}
	p, err := s.Store.Permissions(ctx, u.ID)
	if err != nil {
		return p, err
	}
	if s.Store.Redis != nil {
		data, err := json.Marshal(p)
		if err != nil {
			return p, err
		}
		if err := s.Store.Redis.Set(ctx, key, data, 5*time.Minute).Err(); err != nil {
			return p, err
		}
	}
	return p, nil
}
func (i Identity) Allowed(permission string) bool {
	return slices.Contains(i.Permissions.Roles, "R_SUPER") || permission == "" || slices.Contains(i.Permissions.Buttons, permission)
}
func (i Identity) UserInfo() adminapi.UserInfo {
	return adminapi.UserInfo{UserId: strconv.FormatInt(i.ID, 10), UserName: i.Name, Roles: i.Permissions.Roles, Buttons: i.Permissions.Buttons}
}
func (s *Service) Logout(ctx context.Context, i Identity, actor store.AuditActor) error {
	return s.Store.LogoutSession(ctx, i.ID, i.RefreshID, s.now(), actor)
}
func (s *Service) ChangePassword(ctx context.Context, i Identity, oldPassword, newPassword string, actor store.AuditActor) error {
	if utf8.RuneCountInString(newPassword) < 10 || utf8.RuneCountInString(newPassword) > 128 {
		return domain.Validation()
	}
	hash, err := seed.HashPassword(newPassword)
	if err != nil {
		return err
	}
	return s.Store.ChangePassword(ctx, i.ID, func(hash string) bool { return s.verify(oldPassword, hash) }, hash, s.now(), actor)
}
func (s *Service) Profile(ctx context.Context, i Identity) (adminapi.AdminUser, error) {
	u, err := s.Store.AuthUser(ctx, i.ID)
	if err != nil {
		return adminapi.AdminUser{}, err
	}
	locked := u.LockedUntil != nil && u.LockedUntil.After(s.now())
	return adminapi.AdminUser{Id: u.ID, UserName: u.UserName, NickName: u.NickName, Status: adminapi.EnableStatus(u.Status), Email: u.Email, AvatarUrl: u.AvatarURL, Roles: i.Permissions.Roles, CreateTime: &u.CreatedAt, UpdateTime: &u.UpdatedAt, LastLoginAt: u.LastLoginAt, LastLoginIp: u.LastLoginIP, Locked: &locked}, nil
}

// ProfilePatch tracks nullable-field presence to distinguish omission from explicit clearing.
type ProfilePatch struct {
	Value        adminapi.ProfileUpdate
	EmailSet     bool
	AvatarURLSet bool
}

func (s *Service) UpdateProfile(ctx context.Context, i Identity, patch ProfilePatch, actor store.AuditActor) error {
	p := patch.Value
	fields := map[string]any{}
	if p.NickName != nil {
		fields["nick_name"] = *p.NickName
	}
	if p.Email != nil {
		fields["email"] = string(*p.Email)
	} else if patch.EmailSet {
		fields["email"] = nil
	}
	if p.AvatarUrl != nil {
		fields["avatar_url"] = *p.AvatarUrl
	} else if patch.AvatarURLSet {
		fields["avatar_url"] = nil
	}
	return s.Store.UpdateProfile(ctx, i.ID, fields, actor)
}
func Bearer(header string) string {
	parts := strings.Fields(header)
	if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
		return parts[1]
	}
	return ""
}
