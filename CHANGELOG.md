# Changelog

## [0.1.10](https://github.com/illerax/senju/compare/v0.1.9...v0.1.10) (2026-11-21)


### Bug Fixes

* show agents waiting for background tasks as in background, not finished ([#38](https://github.com/illerax/senju/issues/38)) ([4d99ea4](https://github.com/illerax/senju/commit/4d99ea4fa0fe5cb324afbebb993927c644f23711))

## [0.1.9](https://github.com/illerax/senju/compare/v0.1.8...v0.1.9) (2026-11-20)


### Features

* close groups to disk and reopen them as they were ([#37](https://github.com/illerax/senju/issues/37)) ([8357091](https://github.com/illerax/senju/commit/8357091ff94e18280b7415c037901ff8415f1e57))
* exact agent status from Claude Code hooks ([#34](https://github.com/illerax/senju/issues/34)) ([267c7b6](https://github.com/illerax/senju/commit/267c7b6a05a53617eedb6b9d8395ceff6e609cc0))
* maximize a pane over the whole workspace and restore it ([#31](https://github.com/illerax/senju/issues/31)) ([41ad7ec](https://github.com/illerax/senju/commit/41ad7ec6fe2acd030ffc408ecee51dd5181e30d9))
* notify about agents that need you and queue them by waiting time ([#35](https://github.com/illerax/senju/issues/35)) ([46260b0](https://github.com/illerax/senju/commit/46260b0f5548508684e8ad01b062aed7626f6060))
* overview of all agents with the last lines of their screens ([#36](https://github.com/illerax/senju/issues/36)) ([fc35c23](https://github.com/illerax/senju/commit/fc35c2337bbdd6fb121416446f9aa7a4cf0860ed))
* search a terminal's scrollback ([#33](https://github.com/illerax/senju/issues/33)) ([1b32386](https://github.com/illerax/senju/commit/1b3238680d0f6686898951a04ae27f350659dec7))

## [0.1.8](https://github.com/illerax/senju/compare/v0.1.7...v0.1.8) (2026-11-19)


### Features

* record hangs, errors and the system in diagnostics.log ([#30](https://github.com/illerax/senju/issues/30)) ([b91fac8](https://github.com/illerax/senju/commit/b91fac8679f70714f91fbd79c618b0647a6daa92))


### Bug Fixes

* offer an update only once its installers are attached ([#28](https://github.com/illerax/senju/issues/28)) ([8ac5198](https://github.com/illerax/senju/commit/8ac5198dceff95c984d6acf34b8b8161fa03cae6))

## [0.1.7](https://github.com/illerax/senju/compare/v0.1.6...v0.1.7) (2026-11-19)


### Bug Fixes

* keep paths of AppImage mounts out of the terminals' environment ([#27](https://github.com/illerax/senju/issues/27)) ([d081d7d](https://github.com/illerax/senju/commit/d081d7d7314099db25c35aba885c5ef268a67c29))
* show an agent as working or waiting without a delay ([#25](https://github.com/illerax/senju/issues/25)) ([d181b13](https://github.com/illerax/senju/commit/d181b1308da97bd2d9540fc80bf72fbbd7ab3d4b))

## [0.1.6](https://github.com/illerax/senju/compare/v0.1.5...v0.1.6) (2026-11-19)


### Features

* let the macOS app update itself without code signing ([#24](https://github.com/illerax/senju/issues/24)) ([dde9c1e](https://github.com/illerax/senju/commit/dde9c1e97b3362dca3564df059253dad1400ba7f))
* zoom each tab on its own, on top of the zoom of all terminals ([#23](https://github.com/illerax/senju/issues/23)) ([edfcbc2](https://github.com/illerax/senju/commit/edfcbc2adaa0622b9164f8f57d41f543cda504e3))


### Bug Fixes

* keep mouse reports from spoiling a restored command after a daemon restart ([#21](https://github.com/illerax/senju/issues/21)) ([c0a57ed](https://github.com/illerax/senju/commit/c0a57ed89bdd546f567b6d8d1e9c43bd06898581))

## [0.1.5](https://github.com/illerax/senju/compare/v0.1.4...v0.1.5) (2026-11-19)


### Features

* zoom terminals with shortcuts and Ctrl+mouse wheel ([#20](https://github.com/illerax/senju/issues/20)) ([ef9acaa](https://github.com/illerax/senju/commit/ef9acaa02134dd566562a4dc1d62952c62e2cf18))


### Bug Fixes

* open OSC 8 hyperlinks with Ctrl+click instead of a confirmation dialog ([#17](https://github.com/illerax/senju/issues/17)) ([f5c8250](https://github.com/illerax/senju/commit/f5c825021d0ffedf69619a524db8c70848c14a14))
* open the installed fonts list from the font field in settings ([#19](https://github.com/illerax/senju/issues/19)) ([996ee6f](https://github.com/illerax/senju/commit/996ee6f933cde2c7b9cafbad6155ecabd194863b))

## [0.1.4](https://github.com/illerax/senju/compare/v0.1.3...v0.1.4) (2026-11-19)


### Features

* switch workspaces across groups and move them with shortcuts ([#16](https://github.com/illerax/senju/issues/16)) ([5f248a5](https://github.com/illerax/senju/commit/5f248a570506d152dbbbfd9392edf13878e3c026))


### Bug Fixes

* draw the close pane button as a plain cross ([#12](https://github.com/illerax/senju/issues/12)) ([d08e9c9](https://github.com/illerax/senju/commit/d08e9c9f55d5829462a3371c4d5dbe8e24814ae0))
* keep terminals responsive when a network share or the update server stops answering ([#14](https://github.com/illerax/senju/issues/14)) ([37eebfe](https://github.com/illerax/senju/commit/37eebfe2c2df0d5d59e4bdc03dc8d6788aed0417))
* stop process polling from piling up ps and lsof on macOS ([#15](https://github.com/illerax/senju/issues/15)) ([a95a37c](https://github.com/illerax/senju/commit/a95a37cb0ff54cc805764d9c6fbe1cd3421ce9fa))

## [0.1.3](https://github.com/illerax/senju/compare/v0.1.2...v0.1.3) (2026-11-19)


### Bug Fixes

* check for updates on macOS without latest-mac.yml ([#10](https://github.com/illerax/senju/issues/10)) ([2f5e741](https://github.com/illerax/senju/commit/2f5e741a7b45b8582fadfbd0ccb0dfcd4ad8aaf3))

## [0.1.2](https://github.com/illerax/senju/compare/v0.1.1...v0.1.2) (2026-11-19)


### Features

* add an install script for Linux and macOS ([#7](https://github.com/illerax/senju/issues/7)) ([6ce72e7](https://github.com/illerax/senju/commit/6ce72e7f7bf78103ef90eb91b2a698c598fce465))


### Bug Fixes

* build the Linux packages on Ubuntu 22.04 so terminals start on older systems ([#8](https://github.com/illerax/senju/issues/8)) ([4935101](https://github.com/illerax/senju/commit/493510127bcdcd5d08a0b5a53e8918a48fc315cf))

## [0.1.1](https://github.com/illerax/senju/compare/v0.1.0...v0.1.1) (2026-11-18)


### Features

* check for updates and install them with the user's approval ([#4](https://github.com/illerax/senju/issues/4)) ([ca28d8c](https://github.com/illerax/senju/commit/ca28d8c04fc503e42e962e970b3d931f5ac60e71))
