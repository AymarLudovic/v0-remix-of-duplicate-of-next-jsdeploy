"use client"
import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Loader2,
  Save,
  Trash2,
  Eye,
  Code,
  Terminal,
  Monitor,
  ArrowUp,
  MessageSquare,
  ArrowRight,
  Globe,
  Check,
  ExternalLink,
} from "lucide-react"
import type { GeminiPlan, AnalysisResult, ChatProps, IntegrationConnection } from "@/types"

type StoredFile = {
  path: string
  content: string
  timestamp: number
}

type StoredProject = {
  name: string
  files: StoredFile[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  analysis?: AnalysisResult
  timestamp: number
}

// localStorage utilities
const STORAGE_KEY = "v0_sandbox_files"
const INTEGRATION_STORAGE_KEY = "v0_integrations"

const saveFilesToStorage = (
  projectName: string,
  files: Record<string, string>,
  deps?: Record<string, string>,
  devDeps?: Record<string, string>,
  analysis?: AnalysisResult,
) => {
  try {
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]") as StoredProject[]
    const projectIndex = existing.findIndex((p) => p.name === projectName)

    const storedFiles: StoredFile[] = Object.entries(files).map(([path, content]) => ({
      path,
      content,
      timestamp: Date.now(),
    }))

    const project: StoredProject = {
      name: projectName,
      files: storedFiles,
      dependencies: deps,
      devDependencies: devDeps,
      analysis,
      timestamp: Date.now(),
    }

    if (projectIndex >= 0) {
      existing[projectIndex] = project
    } else {
      existing.push(project)
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing))
    return true
  } catch (e) {
    console.error("Error saving to localStorage:", e)
    return false
  }
}

const getStoredProjects = (): StoredProject[] => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]")
  } catch (e) {
    console.error("Error reading from localStorage:", e)
    return []
  }
}

const deleteStoredProject = (projectName: string): boolean => {
  try {
    const existing = getStoredProjects()
    const filtered = existing.filter((p) => p.name !== projectName)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
    return true
  } catch (e) {
    console.error("Error deleting from localStorage:", e)
    return false
  }
}

const clearAllStoredFiles = (): boolean => {
  try {
    localStorage.removeItem(STORAGE_KEY)
    return true
  } catch (e) {
    console.error("Error clearing localStorage:", e)
    return false
  }
}

const getStoredAnalysis = (projectName: string): AnalysisResult | null => {
  const projects = getStoredProjects()
  const project = projects.find((p) => p.name === projectName)
  return project?.analysis || null
}

// ---------- helpers parsing JSON ----------
function stripCodeFenceToJson(s: string): string | null {
  const fence = s.match(/```json\s*([\s\S]*?)```/i)
  if (fence) return fence[1].trim()
  const fenceAny = s.match(/```\s*([\s\S]*?)```/)
  if (fenceAny) return fenceAny[1].trim()
  return null
}

function extractFirstJsonObject(text: string): string | null {
  const s = text.replace(/\uFEFF/g, "")
  let inStr = false
  let esc = false
  let depth = 0
  let start = -1
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) {
        esc = false
      } else if (ch === "\\") {
        esc = true
      } else if (ch === '"') {
        inStr = false
      }
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === "{") {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (ch === "}") {
      if (depth > 0) depth--
      if (depth === 0 && start !== -1) {
        const candidate = s.slice(start, i + 1).trim()
        try {
          JSON.parse(candidate)
          return candidate
        } catch {
          start = -1
        }
      }
      continue
    }
  }
  return null
}

function safeParsePlan(fullText: string): GeminiPlan {
  const f = stripCodeFenceToJson(fullText)
  if (f) return JSON.parse(f)
  const first = extractFirstJsonObject(fullText)
  if (first) return JSON.parse(first)
  if (fullText.trim() === "") {
    throw new Error("Cannot parse empty string as JSON.")
  }
  return JSON.parse(fullText.trim())
}

// ---------- helpers de génération ----------
const escForTemplate = (s: string) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")

const buildPageFromAnalysis = (analysis: AnalysisResult, projectName: string) => {
  const html = escForTemplate(analysis.fullHTML || "")
  const js = escForTemplate(analysis.fullJS || "")

  return `"use client";
import { useEffect } from "react";

export default function Page() {
  useEffect(() => {
    try {
      // Inject JS directly
      const script = document.createElement("script");
      script.type = "text/javascript";
      script.innerHTML = \`${js}\`;
      document.body.appendChild(script);
      
      return () => {
        try {
          script.remove();
        } catch(e) {}
      };
    } catch(e) {
      console.error('Erreur injection JS:', e);
    }
  }, []);

  return <div dangerouslySetInnerHTML={{ __html: \`${html}\` }} />;
}`
}

const buildGlobalsCssFromAnalysis = (analysis: AnalysisResult) => {
  return `@tailwind base;
@tailwind components;
@tailwind utilities;

${
  analysis.fullCSS ||
  `/* Base styles */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

* {
  box-sizing: border-box;
}

body {
  font-family: 'Inter', sans-serif;
  margin: 0;
  padding: 0;
}`
}`
}

// ---------------- Chat component ----------------
function Chat({ onApplyPlan, onRequestAnalysis, onCombineWithStored }: ChatProps) {
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([
    {
      role: "assistant",
      content: "Hey! I'm your AI coding assistant. What would you like to build today?",
    },
  ])
  const [input, setInput] = useState("")
  const [agentMode, setAgentMode] = useState(true) // Default to agent mode
  const [loading, setLoading] = useState(false)
  const [savedDesign, setSavedDesign] = useState<AnalysisResult | null>(null)
  const [selectedStoredProject, setSelectedStoredProject] = useState<string>("")

  const systemPlanHint = `Tu es un assistant expert pour la création de sites Next.js.
Avant de générer les fichiers Next.js, détecte si le prompt implique de cloner un site réel ou de récupérer son contenu.
Si oui, retourne UN JSON STRICT (voir schéma ci-dessous) OU un objet avec "actions" listant "requestAnalysis" + "writeAnalyzed".

IMPORTANT: Respecte EXACTEMENT le chemin de fichier demandé par l'utilisateur. Si il demande "app/page.tsx", écris dans "app/page.tsx". Si il demande "app/about/page.tsx", écris dans "app/about/page.tsx".

Schéma JSON attendu:
{
  "files": { "<chemin relatif>": "<contenu du fichier>" },
  "dependencies": { "lib": "version" },
  "devDependencies": { "lib": "version" },
  "commands": ["npm install ..."],
  "actions": [
    { "type": "requestAnalysis", "url": "https://example.com", "target": "page" },
    { "type": "writeAnalyzed", "path": "<chemin demandé par l'utilisateur>", "fromAnalysisOf": "https://example.com" }
  ]
}

Réponds UNIQUEMENT par un JSON valide et rien d'autre.`.trim()

  const buildDesignContextPart = (design: AnalysisResult | null, maxCssChars = 4000) => {
    if (!design) return null
    const css = design.fullCSS
      ? design.fullCSS.length > maxCssChars
        ? design.fullCSS.slice(0, maxCssChars) + "\n/*...truncated...*/"
        : design.fullCSS
      : ""
    const htmlSnippet = design.fullHTML
      ? design.fullHTML.length > 2000
        ? design.fullHTML.slice(0, 2000) + "...truncated..."
        : design.fullHTML
      : ""
    return `DESIGN_CONTEXT:
Réutilise les mêmes classes, couleurs, backgrounds et layout pour garder la continuité visuelle sur toutes les pages générées.

CSS:
${css}

HTML snippet:
${htmlSnippet}`
  }

  const handleSend = async () => {
    if (!input.trim()) return
    setLoading(true)
    const userMsg = input
    setMessages((m) => [...m, { role: "user", content: userMsg }])
    setInput("")

    try {
      const contents: any[] = []

      if (agentMode) {
        contents.push({ role: "user", parts: [{ text: systemPlanHint }] })

        if (selectedStoredProject) {
          const storedAnalysis = getStoredAnalysis(selectedStoredProject)
          if (storedAnalysis) {
            setSavedDesign(storedAnalysis)
            setMessages((m) => [
              ...m,
              { role: "assistant", content: "🎨 Récupération des designs pour une continuité sur les autres pages..." },
            ])
          }
        }

        if (savedDesign) {
          contents.push({ role: "user", parts: [{ text: buildDesignContextPart(savedDesign) }] })
          setMessages((m) => [
            ...m,
            { role: "assistant", content: "🎨 Design global détecté → sera réutilisé pour la continuité visuelle." },
          ])
        }
      }

      contents.push({ role: "user", parts: [{ text: userMsg }] })

      const response = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          model: "gemini-2.5-flash",
          applyMode: agentMode,
        }),
      })

      const result = await response.json()
      if (result.error) throw new Error(result.error)

      const full = result.text || "[réponse vide]"
      setMessages((m) => [...m, { role: "assistant", content: full }])

      if (agentMode) {
        let plan: GeminiPlan | null = null
        try {
          plan = safeParsePlan(full)
        } catch {
          throw new Error("Impossible de parser le JSON de Gemini.")
        }

        if (!plan) throw new Error("Gemini n'a pas produit de plan JSON valide.")

        const normalized: GeminiPlan = {
          files: plan.files ? { ...plan.files } : {},
          delete: plan.delete ?? [],
          dependencies: plan.dependencies,
          devDependencies: plan.devDependencies,
          commands: plan.commands ? [...plan.commands] : [],
          actions: plan.actions,
        }

        if (Array.isArray(normalized.actions)) {
          for (const action of normalized.actions) {
            if (action.type === "requestAnalysis" && onRequestAnalysis) {
              const url = action.url || action.fromAnalysisOf
              if (!url) continue
              const analysis = await onRequestAnalysis(url)
              setSavedDesign(analysis)
              normalized.files = normalized.files || {}

              normalized.files["tailwind.config.js"] = `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}`

              normalized.files["postcss.config.js"] = `module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}`

              normalized.devDependencies = {
                ...normalized.devDependencies,
                tailwindcss: "^3.4.0",
                autoprefixer: "^10.4.0",
                postcss: "^8.4.0",
              }

              normalized.files["design.json"] = JSON.stringify(
                {
                  baseURL: analysis.baseURL,
                  title: analysis.title,
                  description: analysis.description,
                  timestamp: Date.now(),
                },
                null,
                2,
              )
            }
            if (action.type === "writeAnalyzed" && onRequestAnalysis) {
              const url = action.fromAnalysisOf || action.url
              if (url) {
                const analysis = await onRequestAnalysis(url)
                setSavedDesign(analysis)

                const dest = action.path || "app/page.tsx"
                const currentProjectName = selectedStoredProject || "default"

                normalized.files = normalized.files || {}

                normalized.files[dest] = buildPageFromAnalysis(analysis, currentProjectName)
                normalized.files["app/globals.css"] = buildGlobalsCssFromAnalysis(analysis)

                normalized.files["tailwind.config.js"] = `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}`

                normalized.files["postcss.config.js"] = `module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}`

                normalized.devDependencies = {
                  ...normalized.devDependencies,
                  tailwindcss: "^3.4.0",
                  autoprefixer: "^10.4.0",
                  postcss: "^8.4.0",
                }

                normalized.files["design.json"] = JSON.stringify(
                  {
                    baseURL: analysis.baseURL,
                    title: analysis.title,
                    description: analysis.description,
                    timestamp: Date.now(),
                  },
                  null,
                  2,
                )
              } else if (action.path && typeof action["content"] === "string") {
                normalized.files = normalized.files || {}
                normalized.files[action.path] = action["content"]
              }
            }
          }
        }

        if (selectedStoredProject && onCombineWithStored) {
          const storedProjects = getStoredProjects()
          const project = storedProjects.find((p) => p.name === selectedStoredProject)
          if (project) {
            const storedFiles: Record<string, string> = {}
            project.files.forEach((f) => {
              storedFiles[f.path] = f.content
            })
            await onCombineWithStored(storedFiles, normalized)
            setMessages((m) => [
              ...m,
              {
                role: "assistant",
                content: `✅ Plan combiné avec les fichiers stockés de "${selectedStoredProject}" et appliqué au sandbox.`,
              },
            ])
            return
          }
        }

        await onApplyPlan(normalized)
        setMessages((m) => [
          ...m,
          { role: "assistant", content: "✅ Plan appliqué dans le sandbox (fichiers écrits + commandes exécutées)." },
        ])
      }
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", content: "❌ Erreur Gemini: " + (e?.message || String(e)) }])
    } finally {
      setLoading(false)
    }
  }

  const storedProjects = getStoredProjects()

  return (
    <div className="bg-[#000000] p-6 space-y-6 h-full relative">
      <div className="h-[80%] bg-[#000000] rounded-xl p-4 overflow-y-auto space-y-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={
                m.role === "user" ? "bg-[#111] text-white p-3 rounded-[10px] max-w-[80%]" : "text-white max-w-[80%]"
              }
            >
              {m.content}
            </div>
          </div>
        ))}
      </div>

      <div className="relative w-full md:w-auto">
        <Button className="absolute bottom-1 left-3 h-[32px] w-[32px] p-0 rounded-[10px] bg-[#111] hover:bg-[#222] text-white">
          <svg width="16" height="16" viewBox="0 0 109 113" fill="none">
            <path
              d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z"
              fill="url(#paint0_linear)"
            />
            <path
              d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z"
              fill="url(#paint1_linear)"
              fillOpacity="0.2"
            />
            <path d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H2.085c-.568 0-1.026-.207-1.325-.598-.307-.403-.387-.964-.22-1.54l2.31-7.917.255-.87c.343-1.18 1.592-2.14 2.786-2.14h2.313c.276 0 .519-.18.595-.442l.764-2.633C9.906 1.208 11.155.249 12.35.249l4.945-.008h3.62c.568 0 1.027.206 1.325.597.307.402.387.964.22 1.54l-1.035 3.566c-.343 1.178-1.593 2.137-2.787 2.137l-4.956.01h-3.61z" />
            <defs>
              <linearGradient
                id="paint0_linear"
                x1="53.9738"
                y1="54.974"
                x2="94.1635"
                y2="71.8295"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="#249361" />
                <stop offset="1" stopColor="#3ECF8E" />
              </linearGradient>
              <linearGradient
                id="paint1_linear"
                x1="36.1558"
                y1="30.578"
                x2="54.4844"
                y2="65.0806"
                gradientUnits="userSpaceOnUse"
              >
                <stop />
                <stop offset="1" stopOpacity="0" />
              </linearGradient>
            </defs>
          </svg>
        </Button>

        <div className="absolute bottom-1 left-16 flex items-center gap-1 bg-[#111] p-1 rounded-lg">
          <button
            onClick={() => setAgentMode(false)}
            className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors ${
              !agentMode ? "bg-white text-black" : "text-white hover:bg-[#222]"
            }`}
          >
            <MessageSquare className="h-4 w-4" />
          </button>
          <button
            onClick={() => setAgentMode(true)}
            className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors ${
              agentMode ? "bg-white text-black" : "text-white hover:bg-[#222]"
            }`}
          >
            <Code className="h-4 w-4" />
          </button>
        </div>

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="What do you want to build?"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !loading) {
              e.preventDefault()
              handleSend()
            }
          }}
          className="w-full min-h-[160px] bg-[#000000] text-white placeholder-gray-400 rounded-[25px] p-6 pl-32 pr-16 resize-none outline-none ring-4 ring-[#222] focus:ring-[#333] transition-all"
          style={{ outline: "none" }}
        />
        <Button
          onClick={handleSend}
          disabled={loading || !input.trim()}
          className="absolute bottom-1 right-4 h-[35px] w-[35px] p-0 rounded-full bg-white hover:bg-gray-100 text-black"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  )
}

// ---------------- LocalStorageManager component ----------------
function LocalStorageManager() {
  const [storedProjects, setStoredProjects] = useState<StoredProject[]>([])
  const [selectedProject, setSelectedProject] = useState<StoredProject | null>(null)
  const [showFileContent, setShowFileContent] = useState<string | null>(null)
  const [showAnalysis, setShowAnalysis] = useState<boolean>(false)

  useEffect(() => {
    setStoredProjects(getStoredProjects())
  }, [])

  const refreshProjects = () => {
    setStoredProjects(getStoredProjects())
    setSelectedProject(null)
    setShowFileContent(null)
    setShowAnalysis(false)
  }

  const handleDeleteProject = (projectName: string) => {
    if (confirm(`Supprimer le projet "${projectName}" ?`)) {
      deleteStoredProject(projectName)
      refreshProjects()
    }
  }

  const handleClearAll = () => {
    if (confirm("Supprimer TOUS les projets stockés ?")) {
      clearAllStoredFiles()
      refreshProjects()
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Save className="h-5 w-5 text-white" />
          Gestionnaire de fichiers localStorage
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Button onClick={refreshProjects} variant="outline" size="sm">
            <Eye className="h-4 w-4 mr-1" />
            Actualiser
          </Button>
          <Button onClick={handleClearAll} variant="destructive" size="sm">
            <Trash2 className="h-4 w-4 mr-1" />
            Tout supprimer
          </Button>
        </div>

        {storedProjects.length === 0 ? (
          <p className="text-muted-foreground text-sm">Aucun projet stocké</p>
        ) : (
          <div className="space-y-2">
            {storedProjects.map((project) => (
              <div key={project.name} className="border rounded p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="font-medium flex items-center gap-2">
                      {project.name}
                      {project.analysis && (
                        <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">🎨 Design</span>
                      )}
                    </h4>
                    <p className="text-sm text-muted-foreground">
                      {project.files.length} fichiers • {new Date(project.timestamp).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      onClick={() => setSelectedProject(selectedProject?.name === project.name ? null : project)}
                      variant="outline"
                      size="sm"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button onClick={() => handleDeleteProject(project.name)} variant="destructive" size="sm">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {selectedProject?.name === project.name && (
                  <div className="mt-3 space-y-2">
                    {project.analysis && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <h5 className="font-medium text-sm">🎨 Design Context:</h5>
                          <Button onClick={() => setShowAnalysis(!showAnalysis)} variant="ghost" size="sm">
                            <Eye className="h-4 w-4" />
                          </Button>
                        </div>
                        {showAnalysis && (
                          <div className="bg-blue-50 p-2 rounded text-xs">
                            <p>
                              <strong>URL:</strong> {project.analysis.baseURL}
                            </p>
                            <p>
                              <strong>HTML:</strong> {project.analysis.fullHTML?.length || 0} caractères
                            </p>
                            <p>
                              <strong>CSS:</strong> {project.analysis.fullCSS?.length || 0} caractères
                            </p>
                            <p>
                              <strong>JS:</strong> {project.analysis.fullJS?.length || 0} caractères
                            </p>
                          </div>
                        )}
                      </div>
                    )}

                    <h5 className="font-medium text-sm">Fichiers:</h5>
                    {project.files.map((file) => (
                      <div key={file.path} className="flex items-center justify-between bg-muted p-2 rounded">
                        <span className="text-sm font-mono">{file.path}</span>
                        <Button
                          onClick={() => setShowFileContent(showFileContent === file.path ? null : file.path)}
                          variant="ghost"
                          size="sm"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}

                    {showFileContent && (
                      <div className="mt-2">
                        <h6 className="font-medium text-sm mb-1">Contenu de {showFileContent}:</h6>
                        <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto max-h-40">
                          {project.files.find((f) => f.path === showFileContent)?.content || "Contenu non trouvé"}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------- Main TestPage component ----------------
const generateProjectName = () => {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_")
  return `project_${timestamp}`
}

export default function TestPage() {
  const [logs, setLogs] = useState<string[]>([])
  const [isChat, setIsChat] = useState(true)
  
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [projectUrl, setProjectUrl] = useState<string | null>(null)
  const [routeInput, setRouteInput] = useState("")
  const [currentSandboxId, setCurrentSandboxId] = useState<string | null>(null)
  const [currentAnalysis, setCurrentAnalysis] = useState<AnalysisResult | null>(null)
  const [activeTab, setActiveTab] = useState<"logs" | "preview">("preview")
  const [showFiles, setShowFiles] = useState(false)
  const [connections, setConnections] = useState<Record<string, IntegrationConnection>>({})
  const [isConnecting, setIsConnecting] = useState<Record<string, boolean>>({})
  const [files, setFiles] = useState<Record<string, string>>({})
  const [projectName, setProjectName] = useState<string>("default")
  const [showTokenModal, setShowTokenModal] = useState<string | null>(null)
  const [deploymentDetails, setDeploymentDetails] = useState<{
    status: "idle" | "deploying" | "success" | "error"
    message: string
    url?: string
    error?: string
  } | null>(null)

  useEffect(() => {
    const storedConnections = localStorage.getItem(INTEGRATION_STORAGE_KEY)
    if (storedConnections) {
      setConnections(JSON.parse(storedConnections))
    }
  }, [])

  const runAction = async (action: string, sandboxId?: string, aiFiles?: any) => {
    try {
      const res = await fetch("/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, sandboxId, aiFiles }),
      })

      const contentType = res.headers.get("content-type")
      if (!contentType || !contentType.includes("application/json")) {
        const textResponse = await res.text()
        throw new Error(`Réponse non-JSON reçue: ${textResponse.substring(0, 200)}...`)
      }

      return await res.json()
    } catch (e: any) {
      console.error("[v0] Run action error:", e)
      return { error: e.message }
    }
  }

  const requestAnalysis = async (url: string): Promise<AnalysisResult> => {
    const response = await fetch("/api/analyse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    })
    const result = await response.json()
    if (result.error) throw new Error(result.error)
    setCurrentAnalysis(result)
    return result
  }

  const applyPlan = async (plan: GeminiPlan) => {
    setLoading(true)
    const autoProjectName = generateProjectName()
    setLogs(["🚀 Starting sandbox with auto-generated project name: " + autoProjectName])

    try {
      const apply = await fetch("/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "applyPlan", plan }),
      })

      const contentType = apply.headers.get("content-type")
      if (!contentType || !contentType.includes("application/json")) {
        const textResponse = await apply.text()
        throw new Error(`Non-JSON response received: ${textResponse.substring(0, 200)}...`)
      }

      const applyResult = await apply.json()
      if (applyResult.error) throw new Error(applyResult.error)

      const sandboxId = applyResult.sandboxId
      setCurrentSandboxId(sandboxId)
      setLogs((prev) => [...prev, `✅ Sandbox created: ${sandboxId}`])

      if (plan.files) {
        const saved = saveFilesToStorage(
          autoProjectName,
          plan.files,
          plan.dependencies,
          plan.devDependencies,
          currentAnalysis,
        )
        if (saved) {
          setLogs((prev) => [...prev, `💾 Files saved to localStorage: ${autoProjectName}`])
        }
      }

      setLogs((prev) => [...prev, "📦 Installing dependencies..."])
      const install = await runAction("install", sandboxId)
      if (install.error) throw new Error(install.error)
      setLogs((prev) => [...prev, ...install.logs.split("\n")])

      setLogs((prev) => [...prev, "⚡️ Building project..."])
      const build = await runAction("build", sandboxId)
      if (build.error) throw new Error(build.error)
      setLogs((prev) => [...prev, ...build.logs.split("\n")])

      setLogs((prev) => [...prev, "🚀 Starting server..."])
      const start = await runAction("start", sandboxId)
      if (start.error) throw new Error(start.error)
      setUrl(start.url)
      setProjectUrl(start.url)
      setLogs((prev) => [...prev, `🌐 Next.js live at: ${start.url}`])
      setActiveTab("preview") // Auto-switch to preview when ready
    } catch (e: any) {
      console.error("[v0] Apply plan error:", e)
      setLogs((prev) => [...prev, `❌ Error: ${e.message}`])
    } finally {
      setLoading(false)
    }
  }

  const combineWithStoredFiles = async (storedFiles: Record<string, string>, newPlan: GeminiPlan) => {
    const combinedPlan: GeminiPlan = {
      ...newPlan,
      files: {
        ...storedFiles,
        ...(newPlan.files || {}),
      },
    }

    await applyPlan(combinedPlan)
  }

  const navigateToRoute = () => {
    if (projectUrl && routeInput.trim()) {
      const route = routeInput.startsWith("/") ? routeInput : `/${routeInput}`
      return `${projectUrl}${route}`
    }
    return projectUrl
  }

  const saveConnection = (connection: IntegrationConnection) => {
    const newConnections = { ...connections, [connection.type]: connection }
    setConnections(newConnections)
    localStorage.setItem(INTEGRATION_STORAGE_KEY, JSON.stringify(newConnections))
  }

  const handleVercelConnect = async () => {
    setShowTokenModal("vercel")
  }

  const handleGitHubConnect = async () => {
    if (!connections.github) {
      setShowTokenModal("github")
      return
    }

    // If already connected, push to GitHub
    const repoName = prompt("Enter repository name:", projectName)
    if (!repoName) return

    setIsConnecting((prev) => ({ ...prev, github: true }))
    try {
      const response = await fetch("/api/deploy/github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files,
          projectName,
          repoName,
          accessToken: connections.github.token,
        }),
      })

      const data = await response.json()
      if (data.success) {
        alert(`Repository created! URL: ${data.repoUrl}`)
      } else {
        alert(`GitHub push failed: ${data.error}`)
      }
    } catch (error) {
      console.error("GitHub push failed:", error)
      alert("GitHub push failed")
    } finally {
      setIsConnecting((prev) => ({ ...prev, github: false }))
    }
  }

  const handleSupabaseConnect = async () => {
    setShowTokenModal("supabase")
  }

  const handleTokenSave = async (type: string, token: string) => {
    setIsConnecting((prev) => ({ ...prev, [type]: true }))

    try {
      const response = await fetch(`/api/auth/${type}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })

      const data = await response.json()

      if (data.success) {
        saveConnection(data.connection)

        // For Supabase, also create .env file
        if (type === "supabase" && data.project) {
          const envContent = `NEXT_PUBLIC_SUPABASE_URL=${data.project.url}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${data.project.anonKey}
SUPABASE_SERVICE_ROLE_KEY=${data.project.serviceRoleKey}`

          const updatedFiles = { ...files, ".env.local": envContent }
          setFiles(updatedFiles)
          saveFilesToStorage(projectName, updatedFiles)
        }

        setShowTokenModal(null)
      } else {
        alert(`Connection failed: ${data.error}`)
      }
    } catch (error) {
      console.error(`${type} connection failed:`, error)
      alert(`${type} connection failed`)
    } finally {
      setIsConnecting((prev) => ({ ...prev, [type]: false }))
    }
  }

  const handleDeploy = async () => {
    if (!connections.vercel) {
      setShowTokenModal("vercel")
      return
    }

    if (!currentSandboxId) {
      setDeploymentDetails({
        status: "error",
        message: "No active sandbox to deploy",
        error: "Please create and build a project first",
      })
      return
    }

    setIsConnecting((prev) => ({ ...prev, deploy: true }))
    setDeploymentDetails({ status: "deploying", message: "Extracting files from sandbox..." })

    try {
      // First, extract files from the sandbox
      console.log("[v0] Extracting files from sandbox:", currentSandboxId)
      const filesResponse = await fetch("/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "getFiles",
          sandboxId: currentSandboxId,
        }),
      })

      const filesData = await filesResponse.json()
      if (!filesData.success) {
        throw new Error(filesData.error || "Failed to extract files from sandbox")
      }

      console.log("[v0] Extracted", filesData.fileCount, "files")
      setDeploymentDetails({ status: "deploying", message: "Deploying to Vercel..." })

      // Now deploy to Vercel
      const response = await fetch("/api/deploy/vercel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: filesData.files,
          projectName,
          token: connections.vercel.token,
        }),
      })

      const data = await response.json()
      if (data.success) {
        setDeploymentDetails({
          status: "success",
          message: "Deployment successful!",
          url: data.url,
        })
      } else {
        setDeploymentDetails({
          status: "error",
          message: "Deployment failed",
          error: data.error || "Unknown error occurred",
        })
      }
    } catch (error: any) {
      console.error("[v0] Deployment failed:", error)
      setDeploymentDetails({
        status: "error",
        message: "Deployment failed",
        error: error.message || "Network error occurred",
      })
    } finally {
      setIsConnecting((prev) => ({ ...prev, deploy: false }))
    }
  }

  const handleGitHubDeploy = async () => {
    if (!connections.github) {
      setShowTokenModal("github")
      return
    }

    if (!currentSandboxId) {
      setLogs((prev) => [...prev, "❌ No active sandbox to deploy"])
      return
    }

    setIsConnecting((prev) => ({ ...prev, github: true }))
    setLogs((prev) => [...prev, "📤 Deploying to GitHub..."])

    try {
      // Extract files from sandbox
      console.log("[v0] Extracting files for GitHub deployment")
      const filesResponse = await fetch("/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "getFiles",
          sandboxId: currentSandboxId,
        }),
      })

      const filesData = await filesResponse.json()
      if (!filesData.success) {
        throw new Error(filesData.error || "Failed to extract files from sandbox")
      }

      // Deploy to GitHub
      const response = await fetch("/api/deploy/github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: filesData.files,
          projectName,
          accessToken: connections.github.token,
          repoName: projectName,
        }),
      })

      const data = await response.json()
      if (data.success) {
        setLogs((prev) => [...prev, `✅ Repository created: ${data.repoUrl}`])
        if (data.uploadSummary) {
          setLogs((prev) => [
            ...prev,
            `📁 Files uploaded: ${data.uploadSummary.successful}/${data.uploadSummary.total}`,
          ])
          if (data.uploadSummary.failed > 0) {
            setLogs((prev) => [...prev, `⚠️ Some files failed to upload: ${data.uploadSummary.failed}`])
          }
        }
      } else {
        setLogs((prev) => [...prev, `❌ GitHub deployment failed: ${data.error}`])
      }
    } catch (error: any) {
      console.error("[v0] GitHub deployment failed:", error)
      setLogs((prev) => [...prev, `❌ GitHub deployment error: ${error.message}`])
    } finally {
      setIsConnecting((prev) => ({ ...prev, github: false }))
    }
  }

  return (
    <div className="min-h-screen bg-[#000000] flex flex-col">
      <header className="bg-[#000000] px-6 py-4 flex items-center justify-between">
        <div className="flex items-center">
          <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5.485 23.76c-.568 0-1.026-.207-1.325-.598-.307-.402-.387-.964-.22-1.54l.672-2.315a.605.605 0 00-.1-.536.622.622 0 00-.494-.243H2.085c-.568 0-1.026-.207-1.325-.598-.307-.403-.387-.964-.22-1.54l2.31-7.917.255-.87c.343-1.18 1.592-2.14 2.786-2.14h2.313c.276 0 .519-.18.595-.442l.764-2.633C9.906 1.208 11.155.249 12.35.249l4.945-.008h3.62c.568 0 1.027.206 1.325.597.307.402.387.964.22 1.54l-1.035 3.566c-.342 1.179-1.592 2.138-2.786 2.138l-4.957.01h-3.61z" />
          </svg>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleGitHubDeploy}
            disabled={isConnecting.github}
            className="h-[29px] w-[150px] bg-[#333] text-white font-semibold rounded-[12px] hover:bg-[#444] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isConnecting.github ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <img src="/github-logo.jpg" alt="GitHub" className="w-4 h-4" />
            )}
            {isConnecting.github ? "Pushing..." : "Push to GitHub"}
          </button>

          <button
            onClick={handleDeploy}
            disabled={isConnecting.deploy}
            className="h-[29px] w-[150px] bg-white text-black font-semibold rounded-[12px] hover:bg-gray-100 transition-colors disabled:opacity-50"
          >
            {isConnecting.deploy ? "Deploying..." : "Deploy Site"}
          </button>

          <Button
            onClick={handleSupabaseConnect}
            disabled={isConnecting.supabase}
            className="absolute left-2 bottom-1 h-[32px] w-[32px] bg-[#0a0a0a] rounded-[10px] flex items-center justify-center text-white hover:bg-[#111] transition-colors disabled:opacity-50"
          >
            {connections.supabase ? (
              <Check className="w-4 h-4 text-green-500" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 109 113" fill="currentColor">
                <path
                  d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z"
                  fill="url(#paint0_linear)"
                />
                <path
                  d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H9.83113C1.64038 72.2922 -2.92775 62.8321 2.1655 56.4175L45.317 2.07103Z"
                  fill="#3ECF8E"
                />
              </svg>
            )}
          </Button>

          <Button
            onClick={() => setShowFiles(!showFiles)}
            variant="outline"
            size="sm"
            className="bg-[#111] border-[#333] text-white hover:bg-[#222]"
          >
            {showFiles ? "Hide Files" : "Show Files"}
          </Button>
        </div>
      </header>


<div className="flex fixed left-[45%] top-1 justify-center gap-3 mb-4">
  <button
    onClick={() => setIsChat(true)}
    className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
      isChat ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400"
    }`}
  >
    Chat
  </button>
  <button
    onClick={() => setIsChat(false)}
    className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
      !isChat ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400"
    }`}
  >
    Preview
  </button>
</div>
      


      
      <div className="flex-1 flex">
        

        <div className={`flex flex-col transition-all duration-300 ${
  isChat ? "w-full md:w-1/2" : "hidden md:flex md:w-1/2"
}`}>
          <Chat
            onApplyPlan={applyPlan}
            onRequestAnalysis={requestAnalysis}
            onCombineWithStored={combineWithStoredFiles}
          />

          {showFiles && (
            <div className="bg-[#111] border-t border-[#333] p-4">
              <div className="flex items-center gap-2 mb-4">
                <Save className="h-5 w-5 text-white" />
                <h3 className="font-semibold text-white">Saved Projects</h3>
              </div>
              <LocalStorageManager />
            </div>
          )}
        </div>

  <div className={`w-1/2 bg-[#0a0a0a] border border-[#111] rounded-xl p-6 flex flex-col transition-all duration-300 ${
  isChat ? "hidden md:flex md:w-1/2" : "w-full md:w-1/2"
}`}>
          <div className="flex items-center gap-1 mb-6 bg-[#111] p-1 rounded-lg w-fit">
            <button
              onClick={() => setActiveTab("preview")}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                activeTab === "preview" ? "bg-white text-black" : "text-white hover:bg-[#222]"
              }`}
            >
              <Monitor className="h-4 w-4" />
              Preview
            </button>
            <button
              onClick={() => setActiveTab("logs")}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                activeTab === "logs" ? "bg-white text-black" : "text-white hover:bg-[#222]"
              }`}
            >
              <Terminal className="h-4 w-4" />
              Logs
            </button>
          </div>

          <div className="flex-1 overflow-hidden">
            {activeTab === "preview" && (
              <div className="h-full space-y-4">
                {projectUrl ? (
                  <>
                    <div className="bg-[#111] border border-[#222] rounded-[20px] p-2 flex gap-2">
                      <input
                        value={routeInput}
                        onChange={(e) => setRouteInput(e.target.value)}
                        placeholder="Enter route (e.g., /about)"
                        className="flex-1 h-[25px] bg-transparent border-none outline-none text-white placeholder-gray-400 px-2"
                      />
                      <button
                        onClick={() => {
                          const iframe = document.getElementById("project-iframe") as HTMLIFrameElement
                          if (iframe) {
                            const route = routeInput.startsWith("/") ? routeInput : `/${routeInput}`
                            iframe.src = projectUrl + route
                          }
                        }}
                        className="h-[25px] px-3 bg-transparent border-none text-white hover:bg-[#222] rounded flex items-center justify-center transition-colors"
                      >
                        <ArrowRight size={16} />
                      </button>
                      <button
                        onClick={() => {
                          const route = routeInput.startsWith("/") ? routeInput : `/${routeInput}`
                          const fullUrl = projectUrl + route
                          window.open(fullUrl, "_blank")
                        }}
                        className="h-[25px] px-3 bg-transparent border-none text-white hover:bg-[#222] rounded flex items-center justify-center transition-colors"
                      >
                        <Globe size={16} />
                      </button>
                    </div>

                    <div className="h-full border border-border/50 rounded-lg overflow-hidden">
                      <iframe
                        id="project-iframe"
                        src={projectUrl}
                        className="w-full h-full"
                        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                      />
                    </div>
                  </>
                ) : (
                  <div className="h-full bg-[#0a0a0a] rounded-lg flex flex-col items-center justify-center">
                    <svg className="w-12 h-12 text-gray-600 mb-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M5.485 23.76c-.568 0-1.026-.207-1.325-.598-.307-.402-.387-.964-.22-1.54l.672-2.315a.605.605 0 00-.1-.536.622.622 0 00-.494-.243H2.085c-.568 0-1.026-.207-1.325-.598-.307-.403-.387-.964-.22-1.54l2.31-7.917.255-.87c.343-1.18 1.592-2.14 2.786-2.14h2.313c.276 0 .519-.18.595-.442l.764-2.633C9.906 1.208 11.155.249 12.35.249l4.945-.008h3.62c.568 0 1.027.206 1.325.597.307.402.387.964.22 1.54l-1.035 3.566c-.343 1.178-1.593 2.137-2.787 2.137l-4.956.01h-3.61z" />
                    </svg>
                    <p className="text-[#e4e4e4] text-center">Preview will appear once your project is built</p>
                  </div>
                )}
              </div>
            )}

            {activeTab === "logs" && (
              <div className="h-full bg-background/50 rounded-lg p-4 overflow-y-auto border border-border/50">
                <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-mono">
                  {logs.length > 0 ? logs.join("\n") : "Logs will appear here during build process..."}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>

      {deploymentDetails && (
        <div className="mb-4 p-4 rounded-lg border border-[#333] bg-[#0a0a0a]">
          <h3 className="text-white font-semibold mb-2">Deployment Status</h3>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              {deploymentDetails.status === "deploying" && (
                <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              )}
              {deploymentDetails.status === "success" && <div className="w-4 h-4 bg-green-500 rounded-full" />}
              {deploymentDetails.status === "error" && <div className="w-4 h-4 bg-red-500 rounded-full" />}
              <span
                className={`text-sm ${
                  deploymentDetails.status === "success"
                    ? "text-green-400"
                    : deploymentDetails.status === "error"
                      ? "text-red-400"
                      : "text-blue-400"
                }`}
              >
                {deploymentDetails.message}
              </span>
            </div>

            {deploymentDetails.url && (
              <a
                href={deploymentDetails.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-blue-400 hover:text-blue-300 text-sm"
              >
                <ExternalLink className="w-4 h-4" />
                {deploymentDetails.url}
              </a>
            )}

            {deploymentDetails.error && (
              <div className="bg-red-900/20 border border-red-500/30 rounded p-3 mt-2">
                <p className="text-red-400 text-sm font-medium">Error Details:</p>
                <p className="text-red-300 text-xs mt-1 font-mono">{deploymentDetails.error}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {showTokenModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#111] border border-[#222] rounded-lg p-6 w-96 max-w-[90vw]">
            <h3 className="text-white font-semibold mb-4">
              Connect {showTokenModal.charAt(0).toUpperCase() + showTokenModal.slice(1)}
            </h3>

            {showTokenModal === "vercel" && (
              <div className="space-y-4">
                <p className="text-[#e4e4e4] text-sm">Get your Personal Access Token from Vercel:</p>
                <a
                  href="https://vercel.com/account/tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-blue-400 hover:text-blue-300 text-sm"
                >
                  <ExternalLink className="w-4 h-4" />
                  vercel.com/account/tokens
                </a>
                <input
                  type="password"
                  placeholder="Enter your Vercel token..."
                  className="w-full bg-[#000] border border-[#333] rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-[#555]"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const token = (e.target as HTMLInputElement).value
                      if (token) handleTokenSave("vercel", token)
                    }
                  }}
                />
              </div>
            )}

            {showTokenModal === "github" && (
              <div className="space-y-4">
                <p className="text-[#e4e4e4] text-sm">Create a Personal Access Token on GitHub:</p>
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo,user"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-blue-400 hover:text-blue-300 text-sm"
                >
                  <ExternalLink className="w-4 h-4" />
                  github.com/settings/tokens/new
                </a>
                <input
                  type="password"
                  placeholder="Enter your GitHub token..."
                  className="w-full bg-[#000] border border-[#333] rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-[#555]"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const token = (e.target as HTMLInputElement).value
                      if (token) handleTokenSave("github", token)
                    }
                  }}
                />
              </div>
            )}

            {showTokenModal === "supabase" && (
              <div className="space-y-4">
                <p className="text-[#e4e4e4] text-sm">Get your Management API token from Supabase:</p>
                <a
                  href="https://supabase.com/dashboard/account/tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-blue-400 hover:text-blue-300 text-sm"
                >
                  <ExternalLink className="w-4 h-4" />
                  supabase.com/dashboard/account/tokens
                </a>
                <input
                  type="password"
                  placeholder="Enter your Supabase token..."
                  className="w-full bg-[#000] border border-[#333] rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-[#555]"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const token = (e.target as HTMLInputElement).value
                      if (token) handleTokenSave("supabase", token)
                    }
                  }}
                />
              </div>
            )}

            <div className="flex gap-2 mt-6">
              <button
                onClick={() => setShowTokenModal(null)}
                className="flex-1 bg-[#333] text-white rounded-lg py-2 hover:bg-[#444] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const input = document.querySelector('input[type="password"]') as HTMLInputElement
                  if (input?.value) handleTokenSave(showTokenModal, input.value)
                }}
                className="flex-1 bg-white text-black rounded-lg py-2 hover:bg-gray-100 transition-colors"
              >
                Save Token
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
