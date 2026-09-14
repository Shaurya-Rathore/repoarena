# RepoArena CLI

RepoArena is CI for AI coding agents. It benchmarks Codex, Claude Code, Gemini
CLI, and OpenCode against real bugs from your repository. Install with Node.js
24:

```sh
npm install --global repoarena
repoarena --version
cd your-repository
repoarena init --yes
repoarena doctor
repoarena agents detect
repoarena tasks discover
```

Local use needs no RepoArena account. RepoArena uses each agent CLI's existing
authentication, so model costs remain BYOK and are paid directly to that
provider. Run `repoarena --help` for task generation, benchmarks, terminal/JSON/
HTML/JUnit reports, optimization, and the loopback-only local UI.

Project documentation: <https://github.com/Shaurya-Rathore/repoarena#readme>
