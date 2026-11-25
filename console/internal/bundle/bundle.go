// Package bundle 把插件的 ES 模块打包成一段可求值的脚本。
//
// 为什么需要它：quickjs-go 的模块加载器没有路径规范化函数（传的是 nil），
// 所以 import 相对路径解析不了。
//
// 做法：每个模块包一层 IIFE，模块内的声明不污染外层；
// 模块的导出挂到共享的 __mod 表上，import 改写成从 __mod 取。
// 这样不同模块里同名的 const（比如 UA）不会互相冲突。
package bundle

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var (
	// export { a, b } from 路径
	reExportFrom = regexp.MustCompile(`(?m)^[ \t]*export\s*\{[^}]*\}\s*from\s+['"]([^'"]+)['"]\s*;?\r?[ \t]*$`)
	// import ... from 路径（1=说明符 2=路径）
	reImportFrom = regexp.MustCompile(`(?m)^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?\r?[ \t]*$`)
	// import 路径
	reImportSide = regexp.MustCompile(`(?m)^[ \t]*import\s+['"]([^'"]+)['"]\s*;?\r?[ \t]*$`)
	// export * from
	reExportStar = regexp.MustCompile(`(?m)^[ \t]*export\s*\*[^;]*;?\r?[ \t]*$`)
	// export { a, b }
	reExportList = regexp.MustCompile(`(?m)^[ \t]*export\s*\{([^}]*)\}\s*;?\r?[ \t]*$`)
	// export 声明
	reExportDecl = regexp.MustCompile(`(?m)^([ \t]*)export\s+(async\s+function|function|const|let|var|class)\s+(\w+)`)
	// 连续空行
	reBlank = regexp.MustCompile(`(?:\r?\n){3,}`)
)

// Result 是打包结果。
type Result struct {
	Code     string
	Order    []string
	Warnings []string
}

// Builder 递归展开一个模块及其依赖。
type Builder struct {
	Root    string
	seen    map[string]bool
	order   []string
	warn    []string
	chunks  []string
	exports map[string][]string
}

// New 创建打包器。root 是插件目录。
func New(root string) *Builder {
	return &Builder{Root: root}
}

// Build 打包 entry（相对插件根目录）。
func (b *Builder) Build(entry string) (*Result, error) {
	return b.BuildExports(entry, nil)
}

// BuildIncremental 只输出尚未求值过的模块，用于在同一个 QuickJS 上下文里
// 分批加载不同入口，避免共享依赖被重复定义（会导致循环引用和栈溢出）。
func (b *Builder) BuildIncremental(entry string, names []string, skip map[string]bool) (*Result, error) {
	b.seen = map[string]bool{}
	for k := range skip {
		b.seen[k] = true
	}
	b.order = nil
	b.warn = nil
	b.chunks = nil
	b.exports = map[string][]string{}

	if err := b.walk(entry); err != nil {
		return nil, err
	}

	var sb strings.Builder
	for _, chunk := range b.chunks {
		sb.WriteString(chunk)
		sb.WriteString("\n")
	}
	entryKey := filepath.ToSlash(filepath.Clean(entry))
	for _, name := range names {
		sb.WriteString(fmt.Sprintf("if (__mod[%q] && typeof __mod[%q][%q] !== 'undefined') globalThis[%q] = __mod[%q][%q];\n", entryKey, entryKey, name, name, entryKey, name))
	}

	return &Result{Code: sb.String(), Order: b.order, Warnings: b.warn}, nil
}

// BuildExports 打包后把指定名字挂到 globalThis，方便 Go 侧调用。
func (b *Builder) BuildExports(entry string, names []string) (*Result, error) {
	b.seen = map[string]bool{}
	b.order = nil
	b.warn = nil
	b.chunks = nil
	b.exports = map[string][]string{}

	if err := b.walk(entry); err != nil {
		return nil, err
	}

	var sb strings.Builder
	sb.WriteString("globalThis.__mod = globalThis.__mod || {};\n")
	for _, chunk := range b.chunks {
		sb.WriteString(chunk)
		sb.WriteString("\n")
	}
	// 导出挂在 __mod[入口] 上，从那里取出来挂到 globalThis
	entryKey := filepath.ToSlash(filepath.Clean(entry))
	for _, name := range names {
		sb.WriteString(fmt.Sprintf("if (__mod[%q] && typeof __mod[%q][%q] !== 'undefined') globalThis[%q] = __mod[%q][%q];\n",
			entryKey, entryKey, name, name, entryKey, name))
	}

	return &Result{Code: sb.String(), Order: b.order, Warnings: b.warn}, nil
}

func (b *Builder) walk(rel string) error {
	rel = filepath.ToSlash(filepath.Clean(rel))
	if b.seen[rel] {
		return nil
	}
	b.seen[rel] = true

	raw, err := os.ReadFile(filepath.Join(b.Root, filepath.FromSlash(rel)))
	if err != nil {
		return fmt.Errorf("读取 %s: %w", rel, err)
	}
	src := string(raw)

	for _, dep := range b.deps(src) {
		resolved, err := b.resolve(rel, dep)
		if err != nil {
			b.warn = append(b.warn, fmt.Sprintf("%s: 跳过 %q（%v）", rel, dep, err))
			continue
		}
		if err := b.walk(resolved); err != nil {
			return err
		}
	}

	b.order = append(b.order, rel)
	b.chunks = append(b.chunks, b.wrap(rel, src))
	return nil
}

// wrap 把一个模块包成 IIFE。
func (b *Builder) wrap(rel, src string) string {
	var sb strings.Builder
	sb.WriteString("// ---- " + rel + " ----\n")
	sb.WriteString("__mod[" + quote(rel) + "] = (function(){\n")
	sb.WriteString("const __e = {};\n")

	body := src

	body = reImportFrom.ReplaceAllStringFunc(body, func(m string) string {
		sub := reImportFrom.FindStringSubmatch(m)
		if sub == nil {
			return m
		}
		resolved, err := b.resolve(rel, sub[2])
		if err != nil {
			return ""
		}
		return b.importToConst(resolved, strings.TrimSpace(sub[1]))
	})
	body = reImportSide.ReplaceAllString(body, "")

	// export { a, b } from './y.js' 是 re-export：
	// 被依赖模块已经执行过，声明在它自己的 IIFE 里，
	// 所以这里不能直接删掉——要把名字登记到 __e，从 __mod 里取值。
	body = reExportFrom.ReplaceAllStringFunc(body, func(m string) string {
		sub := reExportFrom.FindStringSubmatch(m)
		if sub == nil {
			return m
		}
		depPath := sub[1]
		resolved, err := b.resolve(rel, depPath)
		if err != nil {
			return ""
		}
		// 取出花括号里的名单
		inner := ""
		if lb := strings.Index(m, "{"); lb >= 0 {
			if rb := strings.Index(m, "}"); rb > lb {
				inner = m[lb+1 : rb]
			}
		}
		src := "__mod[" + quote(resolved) + "]"
		var out []string
		for _, name := range strings.Split(inner, ",") {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			if i := strings.Index(name, " as "); i > 0 {
				orig := strings.TrimSpace(name[:i])
				alias := strings.TrimSpace(name[i+4:])
				out = append(out, fmt.Sprintf("__e[%q] = %s[%q];", alias, src, orig))
			} else {
				out = append(out, fmt.Sprintf("__e[%q] = %s[%q];", name, src, name))
			}
		}
		return strings.Join(out, " ")
	})
	body = reExportStar.ReplaceAllString(body, "")

	body = reExportList.ReplaceAllStringFunc(body, func(m string) string {
		sub := reExportList.FindStringSubmatch(m)
		if sub == nil {
			return m
		}
		var out []string
		for _, name := range strings.Split(sub[1], ",") {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			// export { 原名 as 别名 }：登记到别名，取值用原名
			if i := strings.Index(name, " as "); i > 0 {
				orig := strings.TrimSpace(name[:i])
				alias := strings.TrimSpace(name[i+4:])
				out = append(out, fmt.Sprintf("__e[%q] = %s;", alias, orig))
			} else {
				out = append(out, fmt.Sprintf("__e[%q] = %s;", name, name))
			}
		}
		return strings.Join(out, " ")
	})

	body = reExportDecl.ReplaceAllStringFunc(body, func(m string) string {
		sub := reExportDecl.FindStringSubmatch(m)
		if sub == nil {
			return m
		}
		indent, kind, name := sub[1], sub[2], sub[3]
		b.exports[rel] = append(b.exports[rel], name)
		return indent + kind + " " + name
	})

	sb.WriteString(body)
	sb.WriteString("\n")
	for _, name := range b.exports[rel] {
		sb.WriteString(fmt.Sprintf("__e[%q] = %s;\n", name, name))
	}
	sb.WriteString("return __e;\n")
	sb.WriteString("})();\n")
	return sb.String()
}

// importToConst 把 import 说明符转成本地绑定。
// 支持三种写法：
//
//	import { a, b as c } from "x"  → const { a, b: c } = __mod["x"]
//	import * as m from "x"         → const m = __mod["x"]
//	import d from "x"              → const d = __mod["x"]
func (b *Builder) importToConst(resolved, spec string) string {
	src := "__mod[" + quote(resolved) + "]"
	switch {
	case strings.HasPrefix(spec, "* as "):
		name := strings.TrimSpace(strings.TrimPrefix(spec, "* as "))
		return fmt.Sprintf("const %s = %s;", name, src)
	case strings.HasPrefix(spec, "{"):
		inner := strings.TrimSuffix(strings.TrimPrefix(spec, "{"), "}")
		var parts []string
		for _, part := range strings.Split(inner, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			if i := strings.Index(part, " as "); i > 0 {
				orig := strings.TrimSpace(part[:i])
				alias := strings.TrimSpace(part[i+4:])
				// 解构重命名用 原名: 别名
				parts = append(parts, orig+": "+alias)
			} else {
				parts = append(parts, part)
			}
		}
		if len(parts) == 0 {
			return ""
		}
		return "const { " + strings.Join(parts, ", ") + " } = " + src + ";\n"
	default:
		return fmt.Sprintf("const %s = %s;", spec, src)
	}
}

func quote(s string) string {
	return "\"" + strings.ReplaceAll(strings.ReplaceAll(s, "\\", "\\\\"), "\"", "\\\"") + "\""
}

// deps 收集静态依赖目标（含 re-export）。
func (b *Builder) deps(src string) []string {
	var out []string
	for _, m := range reImportFrom.FindAllStringSubmatch(src, -1) {
		out = append(out, m[2])
	}
	for _, m := range reImportSide.FindAllStringSubmatch(src, -1) {
		out = append(out, m[1])
	}
	for _, m := range reExportFrom.FindAllStringSubmatch(src, -1) {
		out = append(out, m[1])
	}
	seen := map[string]bool{}
	uniq := make([]string, 0, len(out))
	for _, d := range out {
		if seen[d] {
			continue
		}
		seen[d] = true
		uniq = append(uniq, d)
	}
	return uniq
}

func (b *Builder) resolve(fromRel, spec string) (string, error) {
	if !strings.HasPrefix(spec, ".") {
		return "", fmt.Errorf("非相对路径")
	}
	joined := path.Join(path.Dir(fromRel), spec)
	if _, err := os.Stat(filepath.Join(b.Root, filepath.FromSlash(joined))); err != nil {
		return "", fmt.Errorf("文件不存在")
	}
	return joined, nil
}

// Strip 去掉 import / export 语法，供测试和诊断使用。
func (b *Builder) Strip(src string) string {
	out := reExportFrom.ReplaceAllString(src, "")
	out = reImportFrom.ReplaceAllString(out, "")
	out = reImportSide.ReplaceAllString(out, "")
	out = reExportStar.ReplaceAllString(out, "")
	out = reExportList.ReplaceAllString(out, "")
	out = reExportDecl.ReplaceAllString(out, "${1}${2} ${3}")
	return reBlank.ReplaceAllString(out, "\n\n")
}

// Names 提取导出名。
func Names(src string) []string {
	set := map[string]bool{}
	for _, m := range reExportDecl.FindAllStringSubmatch(src, -1) {
		set[m[3]] = true
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
