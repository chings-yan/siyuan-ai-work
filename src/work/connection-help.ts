/** Built-in maintenance guidance only; opening help never contacts or changes a service. */
export const connectionHelp:Record<'companion'|'pairing'|'serve'|'studio'|'legacy-api'|'ekko',{title:string;paragraphs:readonly string[]}>= {
 companion:{title:'准备与启动本机配套',paragraphs:['普通文档可直接使用；持续工作可建立 Work。Hermes 与 EKKO 均可稍后连接。','配套包需要 Node.js 24。解压到独立目录，先准备配对，再启动 Bridge 并保持窗口运行。已有部署继续使用原启动方式，不重复配对或启动第二个实例。','Windows 按配套包 README 操作；Linux/macOS 在配套目录运行 node scripts/pair.mjs 和 node scripts/bridge-supervisor.mjs。关闭自己启动的窗口可停止该 Bridge，不终止其他进程。','配套信息缺失不影响原有能力核验。需要新增信息时，按本机更新流程保留私有配置，再更新并重启自己的 Bridge。此处不下载、更新或重启。']},
 pairing:{title:'Bridge 配对说明',paragraphs:['Bridge 配对凭据用于插件访问本机配套，与 Hermes 服务授权及 EKKO 账号密码用途不同。','首次准备：在配套目录运行 node scripts/pair.mjs，从自己生成的私有凭据文件复制到密码框。已有配对可留空，不展示已保存凭据。','配对拒绝时核对本机地址与原凭据；重新检测只读核验，点击确认连接才保存。请勿分享凭据或配置全文。']},
 serve:{title:'Hermes 服务授权维护',paragraphs:['授权由原 Hermes 服务管理。缺少授权或被拒绝时，在原服务核对配置和访问权限，再重新检测。','此处只核验认证与会话读取，不创建、续期、替换或撤销授权。生成、停止及外部工具权限仍需实际操作确认。','安装身份不符时先核对原服务，保留旧会话和待核对记录；不要创建替代会话或重复发送。']},
 studio:{title:'Hermes Studio 授权维护',paragraphs:['Studio 授权由原服务管理；当前未提供可信有效期，不从 JWT 推测到期时间。','服务拒绝时核对原 Studio 的专用应用连接与账号/设备。此处不签发、续期或替换授权，不改变 token 文件配置。','读取能力或安装身份不符时，保留原会话，查看诊断摘要后核对原服务。检测成功不保证生成或停止成功。']},
 'legacy-api':{title:'旧会话服务说明',paragraphs:['旧会话服务仅供明确关联旧会话，不能据此确认新建对话能力。','配套未报告版本或能力时显示未知；不因版本差异拒绝连接或强制升级。原授权仍由原服务管理，维护后重新检测。']},
 ekko:{title:'EKKO 应用连接维护',paragraphs:['EKKO 为独立可选连接，未配置不会阻止 Hermes。Bridge 配对与 EKKO 应用连接分开核对。','有效期仅来自应用登录的签发记录，不代表实时认证，也不保证到期前始终可用。服务拒绝或身份不符优先处理；记录过期时本次未验证服务认证。','在 EKKO 的应用连接中核对原账号和设备；配对结果未知时先核对再明确允许重新配对。此处不自动续期、撤销或替换授权，不进入房间或发送消息。']}
};
