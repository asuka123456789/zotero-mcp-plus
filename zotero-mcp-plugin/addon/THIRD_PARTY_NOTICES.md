# 第三方开源软件与许可声明 (Third-Party Notices)

本项目 **Zotero MCP Plus** 派生自开源项目并依赖若干第三方开源工具与库。依据相关开源许可证的要求，特此载明上游项目信息与所包含依赖的许可声明。

---

## 1. 上游开源项目 (Upstream Project)

- **项目名称**: Zotero MCP
- **代码仓库**: [cookjohn/zotero-mcp](https://github.com/cookjohn/zotero-mcp)
- **派生基准 Commit**: `e87f266b45cf26f8756cfa7e0e9d30ebc03b792b` (Tag: `v1.6.0`)
- **开源许可证**: MIT License
- **版权声明**: Copyright (c) 2024 the Zotero-MCP project contributors

```text
MIT License

Copyright (c) 2024 the Zotero-MCP project contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. 运行时依赖包 (Runtime Dependencies)

以下软件包被打包进扩展运行环境或供扩展运行时调用：

### zotero-plugin-toolkit

- **作用**: 封装 Zotero 7+ / Gecko XPCOM 接口、窗口生命周期、偏好注入及 UI 组件工具
- **项目仓库**: https://github.com/windingwind/zotero-plugin-toolkit
- **许可证**: MIT License
- **版权所有**: `Copyright © 2022 <copyright windingwind>`

```text
MIT License

Copyright © 2022 <copyright windingwind>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. 开发、构建与测试工具 (Development, Build & Test Tooling)

以下软件包仅作为离线编译、开发脚手架、静态分析及单元测试工具使用，**未直接打包至终端分发包的运行时业务逻辑中**：

| 软件包名称                 | 许可证类型        | 开发者 / 版权所有                      | 角色与用途                                     |
| :------------------------- | :---------------- | :------------------------------------- | :--------------------------------------------- |
| **zotero-plugin-scaffold** | AGPL-3.0-or-later | northword                              | 仅作为插件离线构建、打包、热重载脚手架 CLI     |
| **zotero-types**           | MIT               | northword                              | Zotero 与 Gecko XPCOM 静态 TypeScript 类型定义 |
| **typescript**             | Apache-2.0        | Microsoft Corporation                  | TypeScript 静态编译器与语法类型检查            |
| **mocha**                  | MIT               | OpenJS Foundation / Mocha contributors | 单元测试框架与测试运行器                       |
| **chai**                   | MIT               | Chai Assertion Library contributors    | BDD/TDD 单元测试断言库                         |
| **eslint**                 | MIT               | OpenJS Foundation                      | 静态代码规范检查工具                           |
| **prettier**               | MIT               | Prettier contributors                  | 代码一致性格式化工具                           |
