package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/redis/go-redis/v9"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type Store struct {
	DB    *gorm.DB
	Redis *redis.Client
}

func Open(ctx context.Context, cfg config.Config) (*Store, error) {
	db, err := gorm.Open(postgres.Open(cfg.DatabaseURL), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent), DisableAutomaticPing: true})
	if err != nil {
		return nil, errors.New("cannot initialize PostgreSQL")
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("get SQL connection: %w", err)
	}
	sqlDB.SetMaxOpenConns(cfg.DBMaxOpenConns)
	sqlDB.SetMaxIdleConns(min(10, cfg.DBMaxOpenConns))
	sqlDB.SetConnMaxLifetime(time.Hour)
	opts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		_ = sqlDB.Close()
		return nil, errors.New("invalid Redis connection configuration")
	}
	st := &Store{DB: db, Redis: redis.NewClient(opts)}
	if err := st.Ready(ctx); err != nil {
		_ = st.Close()
		return nil, err
	}
	return st, nil
}
func (s *Store) Ready(ctx context.Context) error {
	sqlDB, err := s.DB.DB()
	if err != nil {
		return errors.New("PostgreSQL unavailable")
	}
	if err := sqlDB.PingContext(ctx); err != nil {
		return errors.New("PostgreSQL unavailable")
	}
	if err := s.Redis.Ping(ctx).Err(); err != nil {
		return errors.New("redis unavailable")
	}
	return nil
}
func (s *Store) Close() error {
	sqlDB, err := s.DB.DB()
	if err != nil {
		return err
	}
	return errors.Join(sqlDB.Close(), s.Redis.Close())
}
func (s *Store) WithTx(ctx context.Context, fn func(*gorm.DB) error) error {
	return s.DB.WithContext(ctx).Transaction(fn)
}
