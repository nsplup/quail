package main

// encoding.go 单元测试：编码往返（文件失真防护的核心断言——解码→编码
// 必须字节级一致）、BOM 补写、映射完备性与 isTextFile 行为。

import (
	"bytes"
	"testing"

	"golang.org/x/text/encoding/charmap"
)

func utf8BOM(s string) []byte {
	return append([]byte{0xEF, 0xBB, 0xBF}, s...)
}

// TestDecodeToUTF8_BOMPaths BOM 优先路径：内容剥离 BOM、编码标签、bom 标志。
func TestDecodeToUTF8_BOMPaths(t *testing.T) {
	text := "hello 中文"

	// UTF-8 + BOM：bom=true，编码 utf-8
	content, enc, bom, err := decodeToUTF8(utf8BOM(text))
	if err != nil || content != text || enc != "utf-8" || !bom {
		t.Fatalf("utf-8 BOM: content=%q enc=%q bom=%v err=%v", content, enc, bom, err)
	}

	// UTF-16LE + BOM：解码对称，bom=false（UseBOM 编码器自动补 BOM）
	var le []byte
	le = append(le, 0xFF, 0xFE)
	for _, r := range text {
		le = append(le, byte(r&0xFF), byte(r>>8))
	}
	content, enc, bom, err = decodeToUTF8(le)
	if err != nil || content != text || enc != "utf-16le" || bom {
		t.Fatalf("utf-16le BOM: content=%q enc=%q bom=%v err=%v", content, enc, bom, err)
	}

	// UTF-16BE + BOM
	var be []byte
	be = append(be, 0xFE, 0xFF)
	for _, r := range text {
		be = append(be, byte(r>>8), byte(r&0xFF))
	}
	content, enc, bom, err = decodeToUTF8(be)
	if err != nil || content != text || enc != "utf-16be" || bom {
		t.Fatalf("utf-16be BOM: content=%q enc=%q bom=%v err=%v", content, enc, bom, err)
	}

	// 合法 UTF-8 无 BOM：bom=false
	content, enc, bom, err = decodeToUTF8([]byte(text))
	if err != nil || content != text || enc != "utf-8" || bom {
		t.Fatalf("utf-8 plain: content=%q enc=%q bom=%v err=%v", content, enc, bom, err)
	}
}

// TestEncodingRoundTrip 编解码往返：对每个受支持的编码，用其编码器生成
// 原始字节 → decoderFor 解码 → 必须还原为原 UTF-8 文本；encoderFor 再编码
// → 必须与原始字节一致（字节级无损，文件失真核心断言）。
func TestEncodingRoundTrip(t *testing.T) {
	cases := []struct {
		enc  string
		text string
	}{
		{"utf-8", "hello 中文\n第二行"},
		{"gb18030", "中文测试：这是第一段。\n第二段包含更多汉字与标点，共五十六字节以上。"},
		{"gb2312", "中文测试内容，简体汉字编码往返验证。"},
		{"big5", "中文測試：繁體字編碼往返驗證，資訊處理。"},
		{"hz-gb-2312", "中文测试内容，HZ 编码往返验证。"},
		{"shift_jis", "日本語テスト：文字コードの変換検証です。"},
		{"euc-jp", "日本語テスト：EUC-JP エンコーディング検証。"},
		{"iso-2022-jp", "日本語テスト：ISO-2022-JP 検証。"},
		{"euc-kr", "한국어 테스트: 인코딩 변환 검증입니다."},
		{"koi8-r", "Проверка кодировки: русский текст, часть 2."},
		{"koi8-u", "Перевірка кодування: український текст."},
		{"windows-1251", "Проверка кодировки Windows-1251: русский текст."},
		{"windows-1252", "Café naïve résumé — Windows-1252 round trip."},
		{"windows-1254", "İstanbul Türkçe karakter testi."},
		{"windows-1250", "Środkowoeuropejskie testowanie kodowania."},
		{"windows-1253", "Δοκιμή ελληνικής κωδικοποίησης."},
		{"windows-1257", "Baltijas kodējuma pārbaude."},
		{"iso-8859-1", "Café naïve - Latin-1 round trip."},
		{"iso-8859-2", "Łódź Śląsk - Środkowoeuropejskie testy."},
		{"iso-8859-5", "Проверка кодировки ISO-8859-5."},
		{"iso-8859-7", "Δοκιμή ελληνικής κωδικοποίησης ISO-8859-7."},
		{"iso-8859-9", "İstanbul Türkçe ISO-8859-9 testi."},
		{"iso-8859-15", "Café Euro sign € test - Latin-9."},
		{"ibm866", "Проверка кодировки CP866: русский текст."},
		{"mac-cyrillic", "Проверка Mac Cyrillic кодировки."},
		{"windows-874", "การทดสอบการเข้ารหัสภาษาไทย"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.enc, func(t *testing.T) {
			if c.enc == "utf-8" {
				// utf-8 不经 encoderFor（encodeFromUTF8 有专用直写分支），
				// 往返经 decodeToUTF8 验证
				content, enc, bom, err := decodeToUTF8([]byte(c.text))
				if err != nil || content != c.text || enc != "utf-8" || bom {
					t.Fatalf("utf-8 往返: content=%q enc=%q bom=%v err=%v", content, enc, bom, err)
				}
				raw2, err := encodeFromUTF8(content, "utf-8")
				if err != nil || string(raw2) != c.text {
					t.Fatalf("utf-8 写回: %q %v", raw2, err)
				}
				return
			}
			enc := encoderFor(c.enc)
			if enc == nil {
				t.Fatalf("encoderFor(%q) = nil：读得进的编码必须写得出", c.enc)
			}
			raw, err := enc.NewEncoder().Bytes([]byte(c.text))
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			got, err := decoderFor(c.enc).NewDecoder().Bytes(raw)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if string(got) != c.text {
				t.Fatalf("round trip 文本不一致：\n got=%q\nwant=%q", got, c.text)
			}
			raw2, err := enc.NewEncoder().Bytes(got)
			if err != nil || !bytes.Equal(raw, raw2) {
				t.Fatalf("re-encode 字节不一致: err=%v", err)
			}
		})
	}
}

// TestDecodeToUTF8_ChardenPath chardet 检测路径：非 UTF-8、无 BOM 的字节流
// 应被正确识别并解码（取自 TestEncodingRoundTrip 的编码字节）。
func TestDecodeToUTF8_ChardenPath(t *testing.T) {
	text := "中文测试：chardet 编码检测路径验证，这一段足够长以保证识别置信度。"
	raw, err := encoderFor("gb18030").NewEncoder().Bytes([]byte(text))
	if err != nil {
		t.Fatalf("encode gb18030: %v", err)
	}
	content, enc, _, err := decodeToUTF8(raw)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if content != text || (enc != "gb18030" && enc != "gb2312" && enc != "gbk") {
		t.Fatalf("chardet path: content 匹配=%v enc=%q", content == text, enc)
	}
}

// TestEncodeForWrite_BOM 写回 BOM 补写：utf-8 + bom 补写；utf-8 无 bom 直写；
// 非 utf-8 编码忽略 bom 标志（UTF-16 由 UseBOM 编码器对称处理）。
func TestEncodeForWrite_BOM(t *testing.T) {
	raw, err := encodeForWrite("hi", "utf-8", true)
	if err != nil || !bytes.Equal(raw, utf8BOM("hi")) {
		t.Fatalf("utf-8 bom=true: got=% x err=%v", raw, err)
	}
	raw, err = encodeForWrite("hi", "utf-8", false)
	if err != nil || string(raw) != "hi" {
		t.Fatalf("utf-8 bom=false: got=% x err=%v", raw, err)
	}
	raw, err = encodeForWrite("中文", "gb18030", true)
	if err != nil {
		t.Fatalf("gb18030: %v", err)
	}
	if bytes.HasPrefix(raw, []byte{0xEF, 0xBB, 0xBF}) {
		t.Fatalf("非 utf-8 编码不应补 UTF-8 BOM: % x", raw[:3])
	}
	// BOM 往返闭环：带 BOM 写盘 → 读回 → 内容与 bom 标志一致
	full := encodeForWrite2(t, "hi", "utf-8", true)
	content, enc, bom, err := decodeToUTF8(full)
	if err != nil || content != "hi" || enc != "utf-8" || !bom {
		t.Fatalf("BOM 往返闭环失败: content=%q enc=%q bom=%v err=%v", content, enc, bom, err)
	}
}

// encodeForWrite2 测试辅助：出错直接 Fatal。
func encodeForWrite2(t *testing.T, content, enc string, bom bool) []byte {
	t.Helper()
	raw, err := encodeForWrite(content, enc, bom)
	if err != nil {
		t.Fatalf("encodeForWrite: %v", err)
	}
	return raw
}

// TestNormalizeEncoding chardet 标签归一化：关键映射 + decoderFor/encoderFor
// 完备性（此前 koi8-r 分支因大小写不匹配成为死代码，KOI8-R 实际落入
// ISO-8859-1 兜底导致乱码——此测试防回归）。
func TestNormalizeEncoding(t *testing.T) {
	cases := map[string]string{
		"GB-18030":     "gb18030",
		"GB2312":       "gb2312",
		"Big5":         "big5",
		"Shift_JIS":    "shift_jis",
		"EUC-JP":       "euc-jp",
		"EUC-KR":       "euc-kr",
		"KOI8-R":       "koi8-r",
		"windows-1251": "windows-1251",
		"windows-1252": "windows-1252",
		"ISO-8859-1":   "iso-8859-1",
		"UTF-16LE":     "utf-16le",
		"UTF-16BE":     "utf-16be",
		"UTF-8":        "utf-8",
		"ascii":        "utf-8",
	}
	for in, want := range cases {
		if got := normalizeEncoding(in); got != want {
			t.Errorf("normalizeEncoding(%q) = %q, want %q", in, got, want)
		}
	}
	// 关键防回归：KOI8-R 必须映射到 KOI8R 解码器（而非 Windows1251 或兜底）
	if decoderFor("koi8-r") != charmap.KOI8R {
		t.Errorf("decoderFor(koi8-r) 应为 charmap.KOI8R")
	}
}

// TestIsTextFile 文本判定：空/NUL/UTF-8/各国编码/二进制。
func TestIsTextFile(t *testing.T) {
	if !isTextFile(nil) {
		t.Error("空文件应视为文本")
	}
	if isTextFile([]byte("bin\x00ary")) {
		t.Error("含 NUL 应判定为二进制")
	}
	if !isTextFile([]byte("hello 中文 utf-8")) {
		t.Error("合法 UTF-8 应判定为文本")
	}
	gbk, _ := encoderFor("gb18030").NewEncoder().Bytes([]byte("中文文本内容，编码检测样例。"))
	if !isTextFile(gbk) {
		t.Error("GB18030 文本应判定为文本")
	}
	if isTextFile([]byte{0x4D, 0x5A, 0x90, 0x00, 0x00, 0x01}) {
		t.Error("MZ 头（含 NUL）应判定为二进制")
	}
}

func TestNormalizeEOL(t *testing.T) {
	cases := []struct{ in, want string }{
		{"a\nb", "a\nb"},
		{"a\r\nb", "a\nb"},
		{"a\rb", "a\nb"},
		{"a\r\nb\rc\nd", "a\nb\nc\nd"},
		{"a\r\n\r\nb", "a\n\nb"},
		{"\r\n", "\n"},
		{"", ""},
		{"no newline", "no newline"},
	}
	for _, c := range cases {
		if got := normalizeEOL(c.in); got != c.want {
			t.Errorf("normalizeEOL(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
