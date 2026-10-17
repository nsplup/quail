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

// decodeToUTF8 把原始字节转为 UTF-8 文本，返回 (utf8内容, 原编码名, 是否带UTF-8 BOM, err)。
// 编码名是规范化的标签（保存写回时按它编码回去）。
// bom 标志仅在编码名为 "utf-8" 且磁盘原文件带 BOM 时为 true（保存写回时补写，
// 防止 BOM 往返丢失——文件失真防护）；其余编码（如 UTF-16 由 UseBOM 编码器
// 自动补写 BOM）恒为 false。
func decodeToUTF8(raw []byte) (string, string, bool, error) {
        // 1) BOM 优先：最可靠的判定依据
        if len(raw) >= 3 && bytes.Equal(raw[:3], []byte{0xEF, 0xBB, 0xBF}) {
                return string(raw[3:]), "utf-8", true, nil
        }
        if len(raw) >= 2 && raw[0] == 0xFF && raw[1] == 0xFE {
                s, err := unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder().Bytes(raw)
                return string(s), "utf-16le", false, err
        }
        if len(raw) >= 2 && raw[0] == 0xFE && raw[1] == 0xFF {
                s, err := unicode.UTF16(unicode.BigEndian, unicode.UseBOM).NewDecoder().Bytes(raw)
                return string(s), "utf-16be", false, err
        }

        // 2) 已经是合法 UTF-8：直通（空文件也走这里）
        if utf8.Valid(raw) {
                return string(raw), "utf-8", false, nil
        }

        // 3) chardet 启发式检测
        res, err := chardet.NewTextDetector().DetectBest(raw)
        if err != nil {
                return "", "", false, fmt.Errorf("编码检测失败: %w", err)
        }
        enc := normalizeEncoding(res.Charset)
        dec := decoderFor(enc)
        s, err := dec.NewDecoder().Bytes(raw)
        if err != nil {
                return "", "", false, fmt.Errorf("从 %s 转码失败: %w", res.Charset, err)
        }
        return string(s), enc, false, nil
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

// decoderFor 规范化编码标签 → x/text 编码族（取其解码器）。
// 兜底 ISO-8859-1：任意字节序列合法，且字节级往返无损（不会因解码失真）。
func decoderFor(enc string) encoding.Encoding {
        switch enc {
        case "gbk", "gb18030", "gb2312":
                return simplifiedchinese.GB18030
        case "hz-gb-2312":
                return simplifiedchinese.HZGB2312
        case "big5":
                return traditionalchinese.Big5
        case "shift_jis", "sjis", "windows-31j", "cp932":
                return japanese.ShiftJIS
        case "euc-jp":
                return japanese.EUCJP
        case "iso-2022-jp":
                return japanese.ISO2022JP
        case "euc-kr", "euckr", "cp949":
                return korean.EUCKR
        case "iso-8859-1", "latin-1":
                return charmap.ISO8859_1
        case "iso-8859-2":
                return charmap.ISO8859_2
        case "iso-8859-3":
                return charmap.ISO8859_3
        case "iso-8859-4":
                return charmap.ISO8859_4
        case "iso-8859-5":
                return charmap.ISO8859_5
        case "iso-8859-7":
                return charmap.ISO8859_7
        case "iso-8859-9":
                return charmap.ISO8859_9
        case "iso-8859-13":
                return charmap.ISO8859_13
        case "iso-8859-14":
                return charmap.ISO8859_14
        case "iso-8859-15":
                return charmap.ISO8859_15
        case "iso-8859-16":
                return charmap.ISO8859_16
        case "windows-1250":
                return charmap.Windows1250
        case "windows-1251", "cp1251":
                return charmap.Windows1251
        case "windows-1252", "cp1252":
                return charmap.Windows1252
        case "windows-1253":
                return charmap.Windows1253
        case "windows-1254":
                return charmap.Windows1254
        case "windows-1255":
                return charmap.Windows1255
        case "windows-1256":
                return charmap.Windows1256
        case "windows-1257":
                return charmap.Windows1257
        case "windows-1258":
                return charmap.Windows1258
        case "koi8-r":
                return charmap.KOI8R
        case "koi8-u":
                return charmap.KOI8U
        case "ibm855":
                return charmap.CodePage855
        case "ibm866":
                return charmap.CodePage866
        case "mac-cyrillic":
                return charmap.MacintoshCyrillic
        case "windows-874":
                return charmap.Windows874
        case "utf-16le":
                return unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM)
        case "utf-16be":
                return unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM)
        default:
                return charmap.ISO8859_1 // 兜底：任意字节序列合法
        }
}

// encoderFor 规范化编码标签 → x/text 编码族（取其编码器，写回用）。
// 与 decoderFor 保持一一对应：读得进的编码必须写得出（文件失真防护）。
// utf-16 写回时带 BOM，与读入时的 BOM 识别对称。
func encoderFor(enc string) encoding.Encoding {
        switch enc {
        case "gbk", "gb18030", "gb2312":
                return simplifiedchinese.GB18030
        case "hz-gb-2312":
                return simplifiedchinese.HZGB2312
        case "big5":
                return traditionalchinese.Big5
        case "shift_jis", "windows-31j", "cp932":
                return japanese.ShiftJIS
        case "euc-jp":
                return japanese.EUCJP
        case "iso-2022-jp":
                return japanese.ISO2022JP
        case "euc-kr", "cp949":
                return korean.EUCKR
        case "iso-8859-1", "latin-1":
                return charmap.ISO8859_1
        case "iso-8859-2":
                return charmap.ISO8859_2
        case "iso-8859-3":
                return charmap.ISO8859_3
        case "iso-8859-4":
                return charmap.ISO8859_4
        case "iso-8859-5":
                return charmap.ISO8859_5
        case "iso-8859-7":
                return charmap.ISO8859_7
        case "iso-8859-9":
                return charmap.ISO8859_9
        case "iso-8859-13":
                return charmap.ISO8859_13
        case "iso-8859-14":
                return charmap.ISO8859_14
        case "iso-8859-15":
                return charmap.ISO8859_15
        case "iso-8859-16":
                return charmap.ISO8859_16
        case "windows-1250":
                return charmap.Windows1250
        case "windows-1251", "cp1251":
                return charmap.Windows1251
        case "windows-1252", "cp1252":
                return charmap.Windows1252
        case "windows-1253":
                return charmap.Windows1253
        case "windows-1254":
                return charmap.Windows1254
        case "windows-1255":
                return charmap.Windows1255
        case "windows-1256":
                return charmap.Windows1256
        case "windows-1257":
                return charmap.Windows1257
        case "windows-1258":
                return charmap.Windows1258
        case "koi8-r":
                return charmap.KOI8R
        case "koi8-u":
                return charmap.KOI8U
        case "ibm855":
                return charmap.CodePage855
        case "ibm866":
                return charmap.CodePage866
        case "mac-cyrillic":
                return charmap.MacintoshCyrillic
        case "windows-874":
                return charmap.Windows874
        case "utf-16le":
                return unicode.UTF16(unicode.LittleEndian, unicode.UseBOM)
        case "utf-16be":
                return unicode.UTF16(unicode.BigEndian, unicode.UseBOM)
        default:
                return nil
        }
}

// normalizeEncoding 归一化 chardet 的 charset 标签为规范化的编码名
// （与 decoderFor / encoderFor 的 case 一一对应，三者须同步维护）。
func normalizeEncoding(c string) string {
        switch c {
        case "GB-18030", "GB18030":
                return "gb18030"
        case "GB2312":
                return "gb2312"
        case "HZ-GB-2312", "HZ-GB2312":
                return "hz-gb-2312"
        case "Big5":
                return "big5"
        case "Shift_JIS", "SJIS":
                return "shift_jis"
        case "EUC-JP":
                return "euc-jp"
        case "ISO-2022-JP":
                return "iso-2022-jp"
        case "EUC-KR":
                return "euc-kr"
        case "ISO-8859-1", "ISO-8859-1 ":
                return "iso-8859-1"
        case "ISO-8859-2":
                return "iso-8859-2"
        case "ISO-8859-5":
                return "iso-8859-5"
        case "ISO-8859-7":
                return "iso-8859-7"
        case "ISO-8859-9":
                return "iso-8859-9"
        case "windows-1250":
                return "windows-1250"
        case "windows-1251", "Win1251":
                return "windows-1251"
        case "windows-1252", "Win1252":
                return "windows-1252"
        case "windows-1253":
                return "windows-1253"
        case "windows-1254":
                return "windows-1254"
        case "windows-1255":
                return "windows-1255"
        case "windows-1256":
                return "windows-1256"
        case "windows-1257":
                return "windows-1257"
        case "windows-1258":
                return "windows-1258"
        case "KOI8-R":
                return "koi8-r"
        case "KOI8-U":
                return "koi8-u"
        case "IBM855":
                return "ibm855"
        case "IBM866":
                return "ibm866"
        case "MacCyrillic":
                return "mac-cyrillic"
        case "TIS-620", "windows-874":
                return "windows-874"
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
