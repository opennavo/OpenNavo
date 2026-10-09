package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/hibiken/asynq"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/redis/go-redis/v9"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "worker" {
		if !workerReady() {
			os.Exit(1)
		}
		return
	}
	target := "http://localhost:9000/minio/health/ready"
	if len(os.Args) > 1 {
		if os.Args[1] != "api" {
			os.Exit(1)
		}
		target = "http://localhost:8080/readyz"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		cancel()
		os.Exit(1)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		cancel()
		os.Exit(1)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	_ = response.Body.Close()
	cancel()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		os.Exit(1)
	}
}
func workerReady() bool {
	cfg, err := config.Load()
	if err != nil {
		return false
	}
	opts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return false
	}
	opts.DialTimeout = time.Second
	opts.ReadTimeout = time.Second
	opts.WriteTimeout = time.Second
	client := redis.NewClient(opts)
	defer func() { _ = client.Close() }()
	inspector := asynq.NewInspectorFromRedisClient(client)
	servers, err := inspector.Servers()
	if err != nil {
		return false
	}
	host, err := os.Hostname()
	if err != nil {
		return false
	}
	count := 0
	for _, server := range servers {
		if server.Host == host && server.Status == "active" {
			count++
		}
	}
	return count == 2
}
