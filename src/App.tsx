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
import './App.css'

/**
 * PDF stage（layout bookKey 承托面）+ A1 chat。
 * 结算面（复用批撤 / path tick）= 评论层默认跳转；对话在下中。
 */
export default function App() {
  return (
    <div className="app-root">
      <KeyboardNav />
      <main className="stage">
        <CvsScene />
      </main>
      <HUD />
      <A1ChatDock />
      <SettlementDeskPanel />
      <TocWizardBoundary>
        <TocWizard />
      </TocWizardBoundary>
      <ShellZipperControls />
      <ConstructionLensControls />
      <TurnJobProgressGraph />
      <WorkbenchPalette />
      <EmphasisStarMap />
      <OverviewLinkBoard />
      <footer className="patent-bar">
        左键拖拽 · 右键环视 · 滚轮缩放 · A1→Flash · Space+G 星图+笔 · Esc 工作台
      </footer>
    </div>
  )
}
