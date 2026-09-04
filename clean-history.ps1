# ============================================================
# clean-history.ps1 — git 历史清理（把已删游戏等死数据从 .git 抹掉）
# ============================================================
# 背景：git 无法"只删历史中某个文件而不改写历史"；且本项目游戏 id 会被复用
#       （同一个 list/2/ 先后是不同的游戏），按路径清理会误伤新游戏。
#       因此采用【重建历史】策略，效果等价且绝对安全：
#   默认（不传参）：当前全部文件压缩成 1 个全新的根提交，旧历史整体丢弃
#   -Keep N      ：保留最近 N 个提交，更早的历史裁掉（保留部分逐个重放）
#
# 用法（在仓库根目录的 PowerShell 中执行）：
#   .\clean-history.ps1 -DryRun        # 仅预览，不做任何改动
#   .\clean-history.ps1                # 交互模式（破坏性步骤前需输入 y）
#   .\clean-history.ps1 -Keep 5        # 保留最近 5 个提交
#   .\clean-history.ps1 -Yes           # 跳过确认（供熟练使用）
#
# 安全措施：
#   1. 执行前自动在仓库同级目录生成完整备份（含 .git；node_modules 除外）
#   2. 预检不过即拒绝执行（工作区须干净；单分支、无合并提交、无 stash）
#   3. 完成后校验：新历史 tree 哈希与文件数必须与清理前完全一致，不一致自动还原
#   4. 绝不自动 push —— 同步 GitHub 需手动执行（见完成后的提示）
#
# 关于 tag：tag 会钉住旧历史导致清理无效。默认检测到 tag 即中止；
#           加 -DropTags 可自动删除本地 tag（备份里仍可找回）。
#
# 建议：.git 超过 1 GB 或每半年运行一次即可。
# 注意：清理会改变所有提交哈希；之后需 git push --force 同步 GitHub，
#       EdgeOne Pages 会自动重新部署（内容不变）。

param(
  [int]$Keep = 0,            # 保留最近 N 个提交；0 = 全部压缩为 1 个提交
  [string]$BackupPath = "",  # 备份目录（默认：仓库同级 <仓库名>-backup-<时间戳>）
  [switch]$DryRun,           # 仅预览，不做任何改动
  [switch]$Yes,              # 跳过交互确认
  [switch]$DropTags          # 自动删除本地 tag（默认：有 tag 即中止）
)

$ErrorActionPreference = "Stop"

# ---------- 工具 ----------
function Fail([string]$msg) { Write-Host ""; Write-Host "[X] $msg" -ForegroundColor Red; exit 1 }
function Info([string]$msg) { Write-Host $msg -ForegroundColor Cyan }
function Ok([string]$msg)   { Write-Host $msg -ForegroundColor Green }
function DirMB([string]$p) {
  if (-not (Test-Path $p)) { return 0 }
  $s = (Get-ChildItem $p -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  return [math]::Round($s / 1MB, 1)
}

# ---------- 定位仓库 ----------
$RepoRoot = $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot ".git"))) { $RepoRoot = (Get-Location).Path }
if (-not (Test-Path (Join-Path $RepoRoot ".git"))) { Fail "未找到 .git，请在仓库根目录运行本脚本" }
Set-Location $RepoRoot

# ---------- 1. 预检 ----------
Info "== 1/5 预检 =="

$dirty = @(git status --porcelain -uno)
if ($dirty.Count -gt 0) {
  Fail "工作区有未提交的改动（未跟踪的新文件不影响）。请先提交：git add -A; git commit -m '...'"
}

$branch = (git symbolic-ref --short HEAD)
if (-not $branch) { Fail "当前处于分离 HEAD 状态，请先切回分支再运行" }

$heads = @(git for-each-ref refs/heads --format="%(refname:short)")
$others = @($heads | Where-Object { $_ -ne $branch })
if ($others.Count -gt 0) { Fail "存在其他分支（$($others -join ', ')），它们会钉住旧历史。请先删除或合并后再运行" }

$tags = @(git tag)
if ($tags.Count -gt 0 -and -not $DropTags) {
  Fail "检测到 tag：$($tags -join ', ')。tag 会钉住旧历史导致清理无效。如确认不需要，请先执行 git tag -d <tag>，或加 -DropTags 参数重跑"
}

$stash = (git rev-parse -q --verify refs/stash)
if ($stash) { Fail "存在 stash，请先处理（git stash pop 或 git stash drop）再运行" }

$merges = [int](git rev-list --count --merges HEAD)
if ($merges -gt 0) { Fail "历史中存在 $merges 个合并提交，本脚本不支持线性历史以外的场景" }

$commitCount = [int](git rev-list --count HEAD)
if ($commitCount -le 1) { Fail "当前只有 $commitCount 个提交，无需清理" }

if ($Keep -lt 0) { Fail "-Keep 不能是负数" }
if ($Keep -eq 1) { $Keep = 0 }   # 保留 1 个 = 压缩为 1 个
if ($Keep -gt 0 -and $Keep -ge $commitCount) { Fail "总共只有 $commitCount 个提交，不超过要保留的 $Keep 个，无需清理" }

$gitSize = DirMB ".git"
$fileCount = @(git ls-files).Count
$oldest = (git --no-pager log --reverse --format=%cs | Select-Object -First 1)
$mode = if ($Keep -gt 0) { "保留最近 $Keep 个提交，裁掉更早的 $($commitCount - $Keep) 个提交" }
        else { "全部 $commitCount 个提交压缩为 1 个全新提交" }

Write-Host ""
Write-Host "  当前提交数：$commitCount（最早提交：$oldest）"
Write-Host "  跟踪文件数：$fileCount"
Write-Host "  .git 体积 ：$gitSize MB"
Write-Host "  清理模式 ：$mode"
if ($tags.Count -gt 0) { Write-Host "  将删除 tag：$($tags -join ', ')（-DropTags）" -ForegroundColor Yellow }
Write-Host ""

if ($DryRun) {
  Ok "DryRun 预览结束，未做任何改动。清理后 .git 将缩小到接近当前内容单个快照的体积。"
  exit 0
}

# ---------- 2. 备份 ----------
if (-not $BackupPath) {
  $BackupPath = Join-Path (Split-Path $RepoRoot -Parent) (
    "{0}-backup-{1}" -f (Split-Path $RepoRoot -Leaf), (Get-Date -Format "yyyyMMdd-HHmmss"))
}
if (Test-Path $BackupPath) { Fail "备份目录已存在：$BackupPath，请换一个路径（-BackupPath）" }

Info "== 2/5 生成完整备份 =="
Write-Host "  -> $BackupPath"
robocopy $RepoRoot $BackupPath /E /XD node_modules (Split-Path $BackupPath -Leaf) /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "备份失败（robocopy 退出码 $LASTEXITCODE），未做任何改动" }
if (-not (Test-Path (Join-Path $BackupPath ".git\objects"))) { Fail "备份不完整（缺少 .git\objects），已中止" }
Ok "  备份完成（node_modules 除外；如需从备份恢复，恢复后重新 npm install 即可）"

# ---------- 3. 确认 ----------
if (-not $Yes) {
  $ans = Read-Host "即将重写 git 历史（$mode）。所有提交哈希都会变化。确认继续？[y/N]"
  if ($ans -notmatch "^[yY]") { Fail "已取消（备份保留在 $BackupPath）" }
}

# ---------- 4. 重写历史 ----------
Info "== 3/5 重写历史（$mode）=="
$oldTree = (git rev-parse "HEAD^{tree}")
$tip = (git rev-parse HEAD)
$tmpBranch = "history-clean-{0}" -f (Get-Date -Format "HHmmss")

if ($Keep -gt 0) {
  $base = (git rev-parse "HEAD~$($Keep - 1)")
  git checkout --detach $base
  if ($LASTEXITCODE -ne 0) { Fail "定位基线提交失败，未做任何改动" }
}

git checkout --orphan $tmpBranch
if ($LASTEXITCODE -ne 0) { git checkout -f $branch; Fail "创建临时分支失败，已还原" }

if ($Keep -gt 0) {
  # 用基线提交的树和信息做新根提交，再逐个重放其后要保留的提交
  git commit -q -C $base
  if ($LASTEXITCODE -ne 0) { git checkout -f $branch; Fail "创建新根提交失败，已还原" }
  git cherry-pick "$base..$tip"
  if ($LASTEXITCODE -ne 0) {
    git cherry-pick --abort
    git checkout -f $branch
    git branch -D $tmpBranch | Out-Null
    Fail "重放提交失败（正常不应发生），已还原到原分支，未做任何改动"
  }
} else {
  git commit -q -m "历史清理：压缩为单提交，保留全部当前文件（原 $commitCount 个提交，清理于 $(Get-Date -Format yyyy-MM-dd)）"
  if ($LASTEXITCODE -ne 0) { git checkout -f $branch; Fail "创建新根提交失败，已还原" }
}

# 删除本地 tag（在 gc 之前删，否则旧历史仍被钉住）
if ($tags.Count -gt 0) {
  foreach ($t in $tags) { git tag -d $t | Out-Null }
  Write-Host "  已删除本地 tag：$($tags -join ', ')"
}

# ---------- 5. 校验（旧分支还在，可随时还原） ----------
$newTree = (git rev-parse "HEAD^{tree}")
$newFileCount = @(git ls-files).Count
if ($newTree -ne $oldTree -or $newFileCount -ne $fileCount) {
  git checkout -f $branch
  git branch -D $tmpBranch | Out-Null
  Fail "校验失败（tree 哈希或文件数不一致！），已还原到原分支。备份：$BackupPath"
}
Ok "  内容校验通过：tree 哈希一致，$fileCount 个文件一个不少、一字不差"

# ---------- 6. 收尾：删旧分支、清理引用、gc ----------
Info "== 4/5 删除旧分支并压缩 .git（gc 可能需要一两分钟）=="
git branch -D $branch
git branch -m $branch

# 远程跟踪引用与 reflog 会钉住旧历史，清掉后再 gc 才能真正释放空间
$hasOrigin = (@(git remote) -contains "origin")
$originUrl = $null
if ($hasOrigin) { $originUrl = (git remote get-url origin); git remote remove origin }

git reflog expire --expire=now --all
git gc --prune=now --aggressive

if ($hasOrigin -and $originUrl) { git remote add origin $originUrl }

# ---------- 7. 报告 ----------
$newGitSize = DirMB ".git"
$newCommitCount = [int](git rev-list --count HEAD)
$finalDirty = @(git status --porcelain -uno)

Write-Host ""
Ok "== 5/5 清理完成 =="
Write-Host "  .git 体积：$gitSize MB -> $newGitSize MB"
Write-Host "  提交数  ：$commitCount -> $newCommitCount"
Write-Host "  文件数  ：$fileCount（与清理前一致）"
Write-Host "  备份    ：$BackupPath"
if ($finalDirty.Count -gt 0) { Write-Host "  [!] 工作区出现了意外改动，请用备份对比检查" -ForegroundColor Yellow }
Write-Host ""
Write-Host "后续步骤（本脚本不会自动执行）："
Write-Host "  1. 本地抽查：npm run build 后打开 index.html 确认一切正常"
Write-Host "  2. 同步 GitHub（提交哈希已变化，需要强推）："
Write-Host "       git push --force origin $branch"
if ($tags.Count -gt 0) {
  Write-Host "  3. 远程还有被删的 tag 钉着旧历史，确认不需要后删除："
  foreach ($t in $tags) { Write-Host "       git push origin :refs/tags/$t" }
  Write-Host "     （不删也不影响本地瘦身，只是 GitHub 端和新克隆仍会带旧历史）"
}
Write-Host "  4. 线上确认正常后，可删除备份目录"
