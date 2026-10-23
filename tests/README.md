# 代理与配置回归测试

使用 Node.js 22 或更高版本运行，不需要安装项目依赖：

```sh
node --test tests/security-regressions.test.cjs
node --check --input-type=module < _worker.js
git diff --check
```

测试加载实际 `_worker.js`，仅将 `cloudflare:sockets`、网络请求、KV 和 Workers 的 MD5 接口替换为本地适配器。测试覆盖：

- SOCKS5 方法协商、认证、IPv4/域名/IPv6 响应的分片、粘包及截断。
- HTTP CONNECT 的分片响应头、附带首包、后续数据、取消连接和头部长度限制。
- HTTPS 代理使用平台 TLS，并在握手失败时关闭连接，不发送认证信息或重试明文连接。
- 同一 KV 下并发管理请求的配置隔离。
- 旧配置补齐默认字段、损坏配置的内存回退、非法配置返回 400 且不覆盖原配置。
- 伪装站请求头不携带后台 Cookie、Authorization、自定义密钥或访客身份头。
- 请求专属 TCP 连接器及官方 `connect()` 回退。
- 后台 HTTP 出口探测和流锁释放。

## TLS 修复后的兼容性

HTTPS 代理统一使用 Cloudflare 原生 `secureTransport: 'on'`。删除了没有证书链、主机名和握手签名验证的自实现 TLS。证书验证失败不会回退到不安全连接。需要使用受信任且与连接地址匹配的证书；旧的自签名或证书不匹配的 IP 代理可能需要改用代理服务提供的证书域名。

后台 `/admin/check` 改为通过代理请求 `http://cloudflare.com:80/cdn-cgi/trace`，返回 `probe: "http"` 和 `target: "cloudflare.com:80"`。它检测 HTTP 出口连通性及 IP，不证明目标 HTTPS 可用性。仅允许 CONNECT 到 443 的代理可能无法通过该检测，但仍能用于正常 443 转发。HTTPS 代理本身的外层 TLS 仍由平台验证。

这些测试不等同于 Cloudflare 线上验证：证书验证由平台负责，本地测试验证应用正确选择 TLS、处理验证失败和保护凭据。上线前仍需在实际 Worker 中验证证书有效/无效的 HTTPS 代理及各传输协议。
