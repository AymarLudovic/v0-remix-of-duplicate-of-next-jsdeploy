export type GeminiPlan = {
  files?: Record<string, string>
  delete?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  commands?: string[]
  actions?: Array<{
    type: string
    url?: string
    fromAnalysisOf?: string
    path?: string
    target?: string
    [k: string]: any
  }>
}

export type AnalysisResult = {
  fullHTML: string
  fullCSS: string
  fullJS: string
  baseURL: string
}

export type ChatProps = {
  onApplyPlan: (plan: GeminiPlan) => Promise<void>
  onRequestAnalysis?: (url: string) => Promise<AnalysisResult>
  onCombineWithStored?: (storedFiles: Record<string, string>, newPlan: GeminiPlan) => Promise<void>
}

export type IntegrationConnection = {
  type: "vercel" | "github" | "supabase"
  token: string
  userId?: string
  username?: string
  email?: string
  connectedAt: number
}

export type DeploymentResult = {
  success: boolean
  url?: string
  deploymentId?: string
  repoUrl?: string
  projectId?: string
  error?: string
}

export type SupabaseProject = {
  id: string
  name: string
  url: string
  anonKey: string
  serviceRoleKey: string
  region: string
}
