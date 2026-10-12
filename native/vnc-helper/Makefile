CC ?= clang
PKGS := libvncclient

# DEPS_PREFIX를 주면(배포용: scripts/mac/build-native-deps.sh가 만든 정적 라이브러리 prefix) Homebrew 대신
# 그 prefix만 보고 정적 링크 + macOS 최소 버전 고정으로 빌드한다. 비우면 기존처럼 시스템/Homebrew 동적 링크(개발용).
ifdef DEPS_PREFIX
  MIN_MACOS ?= 13.0
  PKGCONFIG := PKG_CONFIG_LIBDIR=$(DEPS_PREFIX)/lib/pkgconfig pkg-config --static
  CFLAGS += -arch arm64 -mmacosx-version-min=$(MIN_MACOS)
  LDFLAGS += -arch arm64 -mmacosx-version-min=$(MIN_MACOS)
else
  PKGCONFIG := pkg-config
endif

CFLAGS += -std=c11 -Wall -Wextra -g -O2 $(shell $(PKGCONFIG) --cflags $(PKGS))
LDFLAGS += $(shell $(PKGCONFIG) --libs $(PKGS)) -lpthread

SRCS := src/main.c src/framing.c src/jsonlite.c
BIN := onegyeok-vnc-helper

$(BIN): $(SRCS) src/framing.h src/jsonlite.h
	$(CC) $(CFLAGS) -o $(BIN) $(SRCS) $(LDFLAGS)

clean:
	rm -f $(BIN)

.PHONY: clean
