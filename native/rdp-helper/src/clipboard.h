#ifndef ONEGYEOK_CLIPBOARD_H
#define ONEGYEOK_CLIPBOARD_H

#include <stdint.h>
#include <freerdp/client/cliprdr.h>

/* cliprdr 채널이 연결/해제될 때(연결 스레드) */
void clip_attach(CliprdrClientContext* context);
void clip_detach(void);
/* Node가 보낸 로컬 클립보드 텍스트(UTF-8) — stdin 스레드에서 호출 */
void clip_set_local_text(const uint8_t* utf8, uint32_t len);
/* Node가 보낸 로컬 클립보드 파일 목록(줄마다 "d\t크기\t상대경로\t절대경로") — 비어 있으면 지움 */
void clip_set_local_files(const uint8_t* data, uint32_t len);
/* 연결 스레드 루프에서 매번 호출 — 새 로컬 텍스트가 있으면 서버에 알린다 */
void clip_poll(void);

#endif
