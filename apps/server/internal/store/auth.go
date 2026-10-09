package store

import (
	"context"
	"strconv"
	"time"

	"github.com/opennavo/opennavo/server/internal/domain"
	"gorm.io/gorm"
)

type AuthUser struct {
	IsMachine                    bool
	ID                           int64
	UserName                     string
	PasswordHash                 string `json:"-"`
	NickName                     string
	Email, AvatarURL             *string
	Status                       string
	SessionVersion, FailedLogins int
	LockedUntil, LastLoginAt     *time.Time
	LastLoginIP                  *string
	CreatedAt, UpdatedAt         time.Time
}
type RefreshRecord struct {
	ID, UserID          int64
	TokenHash, FamilyID string
	ExpiresAt           time.Time
	RevokedAt           *time.Time
	ReplacedBy          *int64
}
type SessionInput struct {
	Hash, Family string
	ExpiresAt    time.Time
	Actor        AuditActor
}
type PermissionSet struct {
	Roles   []string `json:"roles"`
	Buttons []string `json:"buttons"`
}

func authError(code string) error { return &domain.AppError{Code: code, HTTPStatus: 401} }
func (s *Store) AuthUser(ctx context.Context, id int64) (AuthUser, error) {
	var u AuthUser
	err := s.DB.WithContext(ctx).Raw("SELECT * FROM admin_users WHERE id=?", id).Scan(&u).Error
	if err == nil && u.ID == 0 {
		return u, authError(domain.CodeUnauthenticated)
	}
	return u, err
}
func insertRefresh(ctx context.Context, tx *gorm.DB, userID int64, in SessionInput) (int64, error) {
	var id int64
	err := tx.WithContext(ctx).Raw("INSERT INTO admin_refresh_tokens(user_id,token_hash,family_id,expires_at,ip,user_agent) VALUES(?,?,?::uuid,?,?,?) RETURNING id", userID, in.Hash, in.Family, in.ExpiresAt, nullable(in.Actor.IP), nullable(in.Actor.UserAgent)).Scan(&id).Error
	return id, err
}
func (s *Store) LoginSession(ctx context.Context, name string, now time.Time, verify func(string) bool, in SessionInput) (u AuthUser, refreshID int64, result error) {
	err := s.WithTx(ctx, func(tx *gorm.DB) error {
		if err := tx.WithContext(ctx).Raw("SELECT * FROM admin_users WHERE user_name=? FOR UPDATE", name).Scan(&u).Error; err != nil {
			return err
		}
		if u.ID == 0 {
			_ = verify("")
			result = authError(domain.CodeInvalidCredentials)
			return nil
		}
		actor := in.Actor
		actor.ID = &u.ID
		if u.LockedUntil != nil && u.LockedUntil.After(now) {
			result = authError(domain.CodeAccountLocked)
			return nil
		}
		if u.Status != "1" || u.IsMachine {
			result = authError(domain.CodeAccountDisabled)
			return nil
		}
		if !verify(u.PasswordHash) {
			failures := u.FailedLogins + 1
			if u.LockedUntil != nil {
				failures = 1
			}
			var until *time.Time
			if failures >= 5 {
				v := now.Add(15 * time.Minute)
				until = &v
			}
			if err := tx.WithContext(ctx).Exec("UPDATE admin_users SET failed_logins=?,locked_until=?,updated_at=? WHERE id=?", failures, until, now, u.ID).Error; err != nil {
				return err
			}
			result = authError(domain.CodeInvalidCredentials)
			return Audit(ctx, tx, actor, "auth.login.failed", "admin_user", strconv.FormatInt(u.ID, 10), nil, map[string]any{"failedLogins": failures, "locked": until != nil})
		}
		if err := tx.WithContext(ctx).Exec("UPDATE admin_users SET failed_logins=0,locked_until=NULL,last_login_at=?,last_login_ip=?,updated_at=? WHERE id=?", now, nullable(in.Actor.IP), now, u.ID).Error; err != nil {
			return err
		}
		var err error
		refreshID, err = insertRefresh(ctx, tx, u.ID, in)
		if err != nil {
			return err
		}
		return Audit(ctx, tx, actor, "auth.login", "admin_user", strconv.FormatInt(u.ID, 10), nil, map[string]any{"success": true})
	})
	if err != nil {
		return u, 0, err
	}
	return u, refreshID, result
}
func (s *Store) RefreshSession(ctx context.Context, hash string, now time.Time, in SessionInput) (u AuthUser, refreshID int64, result error) {
	err := s.WithTx(ctx, func(tx *gorm.DB) error {
		var ref RefreshRecord
		if err := tx.WithContext(ctx).Raw("SELECT * FROM admin_refresh_tokens WHERE token_hash=?", hash).Scan(&ref).Error; err != nil {
			return err
		}
		if ref.ID == 0 {
			result = authError(domain.CodeUnauthenticated)
			return nil
		}
		if err := tx.WithContext(ctx).Raw("SELECT * FROM admin_users WHERE id=? FOR UPDATE", ref.UserID).Scan(&u).Error; err != nil {
			return err
		}
		if u.ID == 0 {
			result = authError(domain.CodeUnauthenticated)
			return nil
		}
		if err := tx.WithContext(ctx).Raw("SELECT * FROM admin_refresh_tokens WHERE id=? FOR UPDATE", ref.ID).Scan(&ref).Error; err != nil {
			return err
		}
		actor := in.Actor
		actor.ID = &u.ID
		if !ref.ExpiresAt.After(now) {
			result = authError(domain.CodeUnauthenticated)
			return nil
		}
		if u.Status != "1" || u.IsMachine {
			result = authError(domain.CodeAccountDisabled)
			return nil
		}
		if ref.RevokedAt != nil {
			if err := tx.WithContext(ctx).Exec("UPDATE admin_refresh_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE family_id=?::uuid", now, ref.FamilyID).Error; err != nil {
				return err
			}
			result = authError(domain.CodeSessionInvalid)
			return Audit(ctx, tx, actor, "auth.refresh.replay", "admin_user", strconv.FormatInt(u.ID, 10), nil, map[string]any{"familyRevoked": true})
		}
		in.Family = ref.FamilyID
		var err error
		refreshID, err = insertRefresh(ctx, tx, u.ID, in)
		if err != nil {
			return err
		}
		if err := tx.WithContext(ctx).Exec("UPDATE admin_refresh_tokens SET revoked_at=?,replaced_by=? WHERE id=?", now, refreshID, ref.ID).Error; err != nil {
			return err
		}
		return Audit(ctx, tx, actor, "auth.refresh", "admin_user", strconv.FormatInt(u.ID, 10), nil, map[string]any{"rotated": true})
	})
	if err != nil {
		return u, 0, err
	}
	return u, refreshID, result
}
func (s *Store) SessionActive(ctx context.Context, userID, refreshID int64, now time.Time) (bool, error) {
	var active bool
	err := s.DB.WithContext(ctx).Raw(`SELECT EXISTS(SELECT 1 FROM admin_refresh_tokens original JOIN admin_refresh_tokens current ON current.family_id=original.family_id WHERE original.id=? AND original.user_id=? AND current.revoked_at IS NULL AND current.expires_at>?)`, refreshID, userID, now).Scan(&active).Error
	return active, err
}
func (s *Store) Permissions(ctx context.Context, id int64) (PermissionSet, error) {
	out := PermissionSet{Roles: []string{}, Buttons: []string{}}
	if err := s.DB.WithContext(ctx).Raw("SELECT r.role_code FROM admin_roles r JOIN admin_user_roles ur ON ur.role_id=r.id WHERE ur.user_id=? AND r.status='1' ORDER BY r.role_code", id).Scan(&out.Roles).Error; err != nil {
		return out, err
	}
	err := s.DB.WithContext(ctx).Raw(`SELECT DISTINCT p.code FROM admin_permissions p WHERE EXISTS(SELECT 1 FROM admin_user_roles ur JOIN admin_roles r ON r.id=ur.role_id WHERE ur.user_id=? AND r.status='1' AND (r.role_code='R_SUPER' OR EXISTS(SELECT 1 FROM admin_role_permissions rp WHERE rp.role_id=r.id AND rp.permission_code=p.code))) ORDER BY p.code`, id).Scan(&out.Buttons).Error
	return out, err
}
func (s *Store) LogoutSession(ctx context.Context, userID, refreshID int64, now time.Time, actor AuditActor) error {
	return s.WithTx(ctx, func(tx *gorm.DB) error {
		if err := tx.WithContext(ctx).Exec("SELECT id FROM admin_users WHERE id=? FOR UPDATE", userID).Error; err != nil {
			return err
		}
		if err := tx.WithContext(ctx).Exec(`UPDATE admin_refresh_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE family_id=(SELECT family_id FROM admin_refresh_tokens WHERE id=? AND user_id=?)`, now, refreshID, userID).Error; err != nil {
			return err
		}
		return Audit(ctx, tx, actor, "auth.logout", "admin_user", strconv.FormatInt(userID, 10), nil, map[string]any{"familyRevoked": true})
	})
}
func (s *Store) ChangePassword(ctx context.Context, id int64, verify func(string) bool, newHash string, now time.Time, actor AuditActor) error {
	return s.WithTx(ctx, func(tx *gorm.DB) error {
		var u AuthUser
		if err := tx.WithContext(ctx).Raw("SELECT * FROM admin_users WHERE id=? FOR UPDATE", id).Scan(&u).Error; err != nil {
			return err
		}
		if u.ID == 0 {
			return authError(domain.CodeUnauthenticated)
		}
		if !verify(u.PasswordHash) {
			return authError(domain.CodeInvalidCredentials)
		}
		if err := tx.WithContext(ctx).Exec("UPDATE admin_users SET password_hash=?,session_version=session_version+1,updated_at=? WHERE id=?", newHash, now, id).Error; err != nil {
			return err
		}
		if err := tx.WithContext(ctx).Exec("UPDATE admin_refresh_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=?", now, id).Error; err != nil {
			return err
		}
		return Audit(ctx, tx, actor, "profile.password.update", "admin_user", strconv.FormatInt(id, 10), nil, map[string]any{"sessionVersion": u.SessionVersion + 1})
	})
}

func (s *Store) UpdateProfile(ctx context.Context, id int64, fields map[string]any, actor AuditActor) error {
	return s.WithTx(ctx, func(tx *gorm.DB) error {
		var before map[string]any
		if err := tx.WithContext(ctx).Table("admin_users").Select("nick_name,email,avatar_url").Where("id=?", id).Take(&before).Error; err != nil {
			return err
		}
		if len(fields) > 0 {
			fields["updated_at"] = time.Now().UTC()
			if err := tx.WithContext(ctx).Table("admin_users").Where("id=?", id).Updates(fields).Error; err != nil {
				return err
			}
		}
		delete(fields, "updated_at")
		return Audit(ctx, tx, actor, "profile.update", "admin_user", strconv.FormatInt(id, 10), before, fields)
	})
}
