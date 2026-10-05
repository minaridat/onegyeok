CC ?= clang
PKGS := freerdp3 winpr3
CFLAGS += -std=c11 -Wall -Wextra -g -O2 $(shell pkg-config --cflags $(PKGS))
LDFLAGS += $(shell pkg-config --libs $(PKGS)) -lpthread

SRCS := src/main.c src/framing.c src/jsonlite.c
BIN := onegyeok-rdp-helper

$(BIN): $(SRCS) src/framing.h src/jsonlite.h
	$(CC) $(CFLAGS) -o $(BIN) $(SRCS) $(LDFLAGS)

clean:
	rm -f $(BIN)

.PHONY: clean
