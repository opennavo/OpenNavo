package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/opennavo/opennavo/server/internal/backup"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/storage"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "backup operation failed")
		os.Exit(1)
	}
}
func run(ctx context.Context) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	objects, err := storage.New(cfg)
	if err != nil {
		return err
	}
	pg, err := backup.NewPGTools(cfg.DatabaseURL)
	if err != nil {
		return err
	}
	svc := &backup.Service{Database: pg.Database, Tools: pg, Objects: backup.S3Objects{Client: objects}}
	if len(os.Args) < 2 {
		return errors.New("backup command required")
	}
	switch os.Args[1] {
	case "create":
		key, err := svc.Create(ctx)
		if key != "" {
			fmt.Println(key)
		}
		return err
	case "restore":
		if len(os.Args) != 3 {
			return errors.New("backup key required")
		}
		return svc.Restore(ctx, os.Args[2])
	case "daemon":
		for {
			if _, err := svc.Create(ctx); err != nil {
				return err
			}
			next := backup.NextRun(time.Now())
			timer := time.NewTimer(time.Until(next))
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil
			case <-timer.C:
			}
		}
	default:
		return errors.New("invalid backup command")
	}
}
