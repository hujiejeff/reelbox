# Android 签名

自用装包用 debug 包即可;要分发(发给别人、上应用市场)才需要签名。

## 一次性准备

keystore 已生成在本机 `D:\AI WorkSpace\_keys\`:

```
reelbox-release.p12      签名文件(务必长期备份,丢了就无法更新已发布的 App)
keystore-password.txt    密码
keystore.b64             给 GitHub Secret 用的 base64
```

> 重新生成:`openssl req -x509 -newkey rsa:2048 ...` + `openssl pkcs12 -export`,
> 或装了 JDK 后用 `keytool -genkey -v -keystore reelbox.jks -keyalg RSA -keysize 2048 -validity 10000 -alias reelbox`

## 配置 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret:

| Name | 值 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `keystore.b64` 全文(一行) |
| `ANDROID_KEYSTORE_PASSWORD` | `keystore-password.txt` 里的密码 |
| `ANDROID_KEY_ALIAS` | `reelbox` |

配好之后,`mobile` workflow 的 android job 会自动:

1. 解出 keystore 到临时目录
2. 往 `gen/android/app/build.gradle.kts` 追加一段 `signingConfigs`(storeType = PKCS12)与 `buildTypes.release` 绑定
3. 同时给 release 打开 `usesCleartextTraffic`,否则本地反代 `http://127.0.0.1` 在 Android 9+ 被拦

没配 secret 时自动退回 debug 包(调试密钥签名,能装)。

## 注意

- keystore 与密码是**同一把钥匙**:丢了就再也无法覆盖安装已发布的版本(用户只能卸载重装)
- 不要提交进仓库(`_keys/` 在仓库外)
- 密码泄漏 = 别人可以冒名发布更新
