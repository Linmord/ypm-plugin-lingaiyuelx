package hostjs

import (
	"crypto/aes"
	"crypto/md5"
	"encoding/hex"
	"fmt"
)

func md5Hex(text string) string {
	sum := md5.Sum([]byte(text))
	return hex.EncodeToString(sum[:])
}

// aesEcbHex 做 AES-128-ECB + PKCS7，返回原始字节。
func aesEcbHex(key, text string) ([]byte, error) {
	block, err := aes.NewCipher([]byte(key))
	if err != nil {
		return nil, fmt.Errorf("AES key: %w", err)
	}
	plain := []byte(text)
	pad := aes.BlockSize - len(plain)%aes.BlockSize
	for i := 0; i < pad; i++ {
		plain = append(plain, byte(pad))
	}
	out := make([]byte, len(plain))
	for i := 0; i < len(plain); i += aes.BlockSize {
		block.Encrypt(out[i:i+aes.BlockSize], plain[i:i+aes.BlockSize])
	}
	return out, nil
}
