import { CvsScene } from './canvas/CvsScene'
import { HUD } from './ui/HUD'
import { KeyboardNav } from './ui/KeyboardNav'
import { A1ChatDock } from './ui/A1ChatDock'
import { WorkbenchPalette } from './ui/WorkbenchPalette'
import { EmphasisStarMap } from './ui/EmphasisStarMap'
import { OverviewLinkBoard } from './ui/OverviewLinkBoard'
import { ShellZipperControls } from './ui/ShellZipperControls'
import { ConstructionLensControls } from './ui/ConstructionLensControls'
import { TurnJobProgressGraph } from './ui/TurnJobProgressGraph'
import { SettlementDeskPanel } from './ui/SettlementDeskPanel'
import { TocWizard } from './ui/TocWizard'
import { TocWizardBoundary } from './ui/TocWizardBoundary'
import { useDocuverse } from './canvas/store'
import './App.css'

/**
 * 语料瘦载入 → 写信台工作台 → 入窗 bookKey 时并行出页 → 结算可续审。
 */
export default function App() {
  const letterWorkbench = useDocuverse((s) => s.letterWorkbenchMode)
  const sphereAudit = useDocuverse((s) => s.sphereAuditOpen)
  const indexReadyHint = useDocuverse((s) => s.uploadLabel)
  const showSphere = !letterWorkbench || sphereAudit

  return (
    <div
      className={
        letterWorkbench && !sphereAudit
          ? 'app-root app-root--letter-workbench'
          : 'app-root'
      }
    >
      <KeyboardNav />
      <main className="stage">
        {showSphere ? (
          <CvsScene />
        ) : (
          <div className="letter-workbench-stage" aria-label="写信台工作台">
            <p className="letter-workbench-title">写信台工作台</p>
            <p className="letter-workbench-sub">
              语料已就绪
              {indexReadyHint ? ` · ${indexReadyHint}` : ''}
              。球与页图默认隐藏；底部提问即可筛选 key 开工。
              当 bookKey 进入本轮 peek/infer 窗时并行解码对应页；结算可继续切换审计。
            </p>
          </div>
        )}
      </main>
      <HUD />
      <A1ChatDock />
      <SettlementDeskPanel />
      <TocWizardBoundary>
        <TocWizard />
      </TocWizardBoundary>
      {showSphere && <ShellZipperControls />}
      {showSphere && <ConstructionLensControls />}
      <TurnJobProgressGraph />
      <WorkbenchPalette />
      <EmphasisStarMap />
      <OverviewLinkBoard />
      <footer className="patent-bar">
        {letterWorkbench && !sphereAudit
          ? '写信台模式 · 提问开工 · 入窗 bookKey 时并行出页'
          : '左键拖拽 · 右键环视 · 滚轮缩放 · A1→Flash · Space+G 星图+笔 · Esc 工作台'}
      </footer>
    </div>
  )
}
