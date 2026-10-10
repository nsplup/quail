package main

// 文档编码检测与转码：磁盘字节 ↔ UTF-8。
//
// - 读入：检测 BOM → chardet 启发式检测 → 统一转为 UTF-8 交给前端；
//   原编码名记录在 DocState.Encoding。
// - 写回：按 DocState.Encoding 把 UTF-8 内容编码回原编码（无法映射的字符
//   由 x/text 替换为 '?'）；原编码为 utf-8 时直写。

import (
        "bytes"
        "fmt"
        "unicode/utf8"

        "github.com/saintfish/chardet"
        "golang.org/x/text/encoding"
        "golang.org/x/text/encoding/charmap"
        "golang.org/x/text/encoding/japanese"
        "golang.org/x/text/encoding/korean"
        "golang.org/x/text/encoding/simplifiedchinese"
        "golang.org/x/text/encoding/traditionalchinese"
        "golang.org/x/text/encoding/unicode"
)

// isTextFile 判定原始字节是否为文本文件（Open 输入过滤用）：
//   - 空文件视为文本；
//   - 含 NUL 字节判定为二进制（可执行文件/媒体/压缩包等二进制格式的通用
//     特征，Go http.DetectContentType 与 git 均采用同一启发式）；
//   - 其余交给 chardet：BOM / 合法 UTF-8 / 各国文本编码均可识别，识别
//     失败视为非文本。
func isTextFile(raw []byte) bool {
        if len(raw) == 0 {
                return true
        }
        if bytes.IndexByte(raw, 0x00) >= 0 {
                return false
        }
        if utf8.Valid(raw) {
                return true
        }
        _, err := chardet.NewTextDetector().DetectBest(raw)
        return err == nil
}

// decodeToUTF8 把原始字节转为 UTF-8 文本，返回 (utf8内容, 原编码名, err)。
// 编码名是规范化的标签（保存写回时按它编码回去）。
func decodeToUTF8(raw []byte) (string, string, error) {
        // 1) BOM 优先：最可靠的判定依据
        if len(raw) >= 3 && bytes.Equal(raw[:3], []byte{0xEF, 0xBB, 0xBF}) {
                return string(raw[3:]), "utf-8", nil
        }
        if len(raw) >= 2 && raw[0] == 0xFF && raw[1] == 0xFE {
                s, err := unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder().Bytes(raw)
                return string(s), "utf-16le", err
        }
        if len(raw) >= 2 && raw[0] == 0xFE && raw[1] == 0xFF {
                s, err := unicode.UTF16(unicode.BigEndian, unicode.UseBOM).NewDecoder().Bytes(raw)
                return string(s), "utf-16be", err
        }

        // 2) 已经是合法 UTF-8：直通（空文件也走这里）
        if utf8.Valid(raw) {
                return string(raw), "utf-8", nil
        }

        // 3) chardet 启发式检测
        res, err := chardet.NewTextDetector().DetectBest(raw)
        if err != nil {
                return "", "", fmt.Errorf("编码检测失败: %w", err)
        }
        dec := decoderFor(res.Charset)
        s, err := dec.NewDecoder().Bytes(raw)
        if err != nil {
                return "", "", fmt.Errorf("从 %s 转码失败: %w", res.Charset, err)
        }
        return string(s), normalizeEncoding(res.Charset), nil
}

// encodeFromUTF8 把 UTF-8 文本按目标编码编码回去。
func encodeFromUTF8(text, enc string) ([]byte, error) {
        switch enc {
        case "", "utf-8":
                return []byte(text), nil
        }
        enc2 := encoderFor(enc)
        if enc2 == nil {
                return nil, fmt.Errorf("不支持的写回编码: %s", enc)
        }
        return enc2.NewEncoder().Bytes([]byte(text))
}

// decoderFor chardet 报告的 charset 名 → x/text 编码族（取其解码器）。
func decoderFor(charset string) encoding.Encoding {
        switch normalizeEncoding(charset) {
        case "gbk", "gb18030", "gb2312":
                return simplifiedchinese.GB18030
        case "big5":
                return traditionalchinese.Big5
        case "shift_jis", "sjis", "windows-31j", "cp932":
                return japanese.ShiftJIS
        case "euc-kr", "euckr", "cp949":
                return korean.EUCKR
        case "iso-8859-1", "latin-1":
                return charmap.ISO8859_1
        case "windows-1252", "cp1252":
                return charmap.Windows1252
        case "windows-1251", "koi8-r":
                return charmap.Windows1251
        case "utf-16le":
                return unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM)
        case "utf-16be":
                return unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM)
        default:
                return charmap.ISO8859_1 // 兜底：任意字节序列合法
        }
}

// encoderFor 编码名 → x/text 编码族（取其编码器，写回用）。
// utf-16 写回时带 BOM，与读入时的 BOM 识别对称。
func encoderFor(enc string) encoding.Encoding {
        switch enc {
        case "gbk", "gb18030", "gb2312":
                return simplifiedchinese.GB18030
        case "big5":
                return traditionalchinese.Big5
        case "shift_jis":
                return japanese.ShiftJIS
        case "euc-kr":
                return korean.EUCKR
        case "iso-8859-1":
                return charmap.ISO8859_1
        case "windows-1252":
                return charmap.Windows1252
        case "windows-1251":
                return charmap.Windows1251
        case "utf-16le":
                return unicode.UTF16(unicode.LittleEndian, unicode.UseBOM)
        case "utf-16be":
                return unicode.UTF16(unicode.BigEndian, unicode.UseBOM)
        default:
                return nil
        }
}

// normalizeEncoding 归一化 chardet 的 charset 标签。
func normalizeEncoding(c string) string {
        switch c {
        case "GB-18030", "GB18030":
                return "gb18030"
        case "GB2312":
                return "gb2312"
        case "Big5":
                return "big5"
        case "Shift_JIS", "SJIS":
                return "shift_jis"
        case "EUC-KR":
                return "euc-kr"
        case "ISO-8859-1", "ISO-8859-1 ":
                return "iso-8859-1"
        case "windows-1252", "Win1252":
                return "windows-1252"
        case "windows-1251":
                return "windows-1251"
        case "UTF-16LE":
                return "utf-16le"
        case "UTF-16BE":
                return "utf-16be"
        case "UTF-8", "ascii", "ASCII":
                return "utf-8"
        default:
                return c
        }
}
