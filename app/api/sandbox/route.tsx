import { NextResponse } from "next/server"
import * as e2b from "@e2b/code-interpreter"

export async function POST(req: Request) {
  try {
    const body = await req.json().catch((e) => {
      console.error("[v0] Failed to parse request JSON:", e)
      throw new Error("Invalid JSON in request body")
    })

    const { action, sandboxId: bodySandboxId, plan } = body || {}

    const apiKey = process.env.E2B_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: "E2B_API_KEY manquant" }, { status: 500 })
    }

    console.log("[v0] Sandbox API called with action:", action)

    switch (action) {
      case "create": {
        console.log("[v0] Creating new sandbox...")
        const sandbox = await e2b.Sandbox.betaCreate({
          apiKey,
          timeoutMs: 900000, // 15 minutes
          autoPause: true, // Enable auto-pause to preserve sandbox state
        })

        // Create default Next.js structure
        const defaultPackageJson = {
          name: "nextjs-app",
          private: true,
          scripts: {
            dev: "next dev -p 3000 -H 0.0.0.0",
            build: "next build",
            start: "next start -p 3000 -H 0.0.0.0",
          },
          dependencies: {
            next: "14.2.3",
            react: "18.2.0",
            "react-dom": "18.2.0",
          },
        }

        await sandbox.files.write("/home/user/package.json", JSON.stringify(defaultPackageJson, null, 2))

        await sandbox.files.write(
          "/home/user/app/layout.tsx",
          `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}`.trim(),
        )

        await sandbox.files.write(
          "/home/user/app/page.tsx",
          `"use client";
export default function Page() {
  return <h1>🚀 Hello depuis Next.js dans E2B</h1>;
}`.trim(),
        )

        console.log("[v0] Default Next.js structure created")
        return NextResponse.json({ sandboxId: sandbox.sandboxId })
      }

      case "applyPlan": {
        console.log("[v0] Applying plan to sandbox...")
        console.log("[v0] Plan received:", JSON.stringify(plan, null, 2))

        let sid: string | null = bodySandboxId || null
        let sandbox: e2b.Sandbox

        if (!sid) {
          console.log("[v0] No sandbox ID provided, creating new sandbox...")
          sandbox = await e2b.Sandbox.betaCreate({
            apiKey,
            timeoutMs: 900000, // 15 minutes
            autoPause: true,
          })
          sid = sandbox.sandboxId
        } else {
          console.log("[v0] Connecting to existing sandbox:", sid)
          sandbox = await e2b.Sandbox.connect(sid, {
            apiKey,
            timeoutMs: 900000, // 15 minutes
          })
          await sandbox.setTimeout(900000)
        }

        const hasCustomDeps = plan?.dependencies && Object.keys(plan.dependencies).length > 0
        const hasCustomDevDeps = plan?.devDependencies && Object.keys(plan.devDependencies).length > 0

        const packageJson = {
          name: "nextjs-app",
          private: true,
          scripts: {
            dev: "next dev -p 3000 -H 0.0.0.0",
            build: "next build",
            start: "next start -p 3000 -H 0.0.0.0",
          },
          dependencies: {
            next: "14.2.3",
            react: "18.2.0",
            "react-dom": "18.2.0",
            ...(hasCustomDeps ? plan.dependencies : {}),
          },
          ...(hasCustomDevDeps && { devDependencies: plan.devDependencies }),
        }

        console.log("[v0] Writing package.json:", JSON.stringify(packageJson, null, 2))
        await sandbox.files.write("/home/user/package.json", JSON.stringify(packageJson, null, 2))

        if (!plan?.files?.["app/layout.tsx"]) {
          console.log("[v0] Writing default layout.tsx")
          await sandbox.files.write(
            "/home/user/app/layout.tsx",
            `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}`.trim(),
          )
        }

        if (Array.isArray(plan?.delete)) {
          for (const p of plan.delete) {
            try {
              console.log("[v0] Deleting file:", p)
              await sandbox.files.delete(`/home/user/${p}`)
            } catch (e) {
              console.log("[v0] Could not delete file:", p, e)
            }
          }
        }

        if (plan?.files) {
          console.log("[v0] Writing AI-generated files...")
          for (const [path, content] of Object.entries(plan.files)) {
            console.log("[v0] Writing file:", path)
            await sandbox.files.write(`/home/user/${path}`, String(content))
          }
          console.log("[v0] All AI files written successfully")
        }

        return NextResponse.json({
          success: true,
          sandboxId: sid,
          message: "Plan applied successfully",
          filesWritten: plan?.files ? Object.keys(plan.files).length : 0,
        })
      }

      case "install": {
        const sid = bodySandboxId
        if (!sid) throw new Error("sandboxId manquant")

        console.log("[v0] Installing dependencies for sandbox:", sid)
        const sandbox = await e2b.Sandbox.connect(sid, {
          apiKey,
          timeoutMs: 900000, // Extended timeout for install
        })

        await sandbox.setTimeout(900000)

        const { stdout, stderr } = await sandbox.commands.run("npm install --no-audit --loglevel warn", {
          cwd: "/home/user",
          timeoutMs: 600000, // Increased to 10 minutes for npm install
        })

        console.log("[v0] Install completed")
        return NextResponse.json({ success: true, logs: stdout + stderr })
      }

      case "build": {
        const sid = bodySandboxId
        if (!sid) throw new Error("sandboxId manquant")

        console.log("[v0] Building project for sandbox:", sid)
        const sandbox = await e2b.Sandbox.connect(sid, {
          apiKey,
          timeoutMs: 900000, // Extended timeout
        })

        await sandbox.setTimeout(900000)

        const { stdout, stderr } = await sandbox.commands.run("npm run build", {
          cwd: "/home/user",
          timeoutMs: 300000, // Increased to 5 minutes for build
        })

        console.log("[v0] Build completed")
        return NextResponse.json({ success: true, logs: stdout + stderr })
      }

      case "start": {
        const sid = bodySandboxId
        if (!sid) throw new Error("sandboxId manquant")

        console.log("[v0] Starting server for sandbox:", sid)
        const sandbox = await e2b.Sandbox.connect(sid, {
          apiKey,
          timeoutMs: 900000, // Extended timeout
        })

        await sandbox.setTimeout(900000)

        sandbox.commands.start("npm run start", { cwd: "/home/user" })

        const url = `https://${sandbox.getHost(3000)}`
        console.log("[v0] Server started at:", url)

        return NextResponse.json({ success: true, url })
      }

      case "getFiles": {
        const sid = bodySandboxId
        if (!sid) throw new Error("sandboxId manquant")

        console.log("[v0] Extracting files from sandbox:", sid)

        try {
          let sandbox: e2b.Sandbox
          try {
            sandbox = await e2b.Sandbox.connect(sid, {
              apiKey,
              timeoutMs: 900000,
            })
          } catch (connectError: any) {
            console.log("[v0] Failed to connect to sandbox, it may be paused or expired:", connectError.message)
            throw new Error(`Sandbox ${sid} is no longer available. It may have expired or been paused.`)
          }

          await sandbox.setTimeout(900000)

          const { stdout: fileList } = await sandbox.commands.run(
            "find . -type f -not -path './node_modules/*' -not -path './.next/*' -not -path './.*'",
            {
              cwd: "/home/user",
            },
          )

          const files: Record<string, string> = {}
          const filePaths = fileList
            .trim()
            .split("\n")
            .filter((path) => path && path !== ".")

          console.log("[v0] Found", filePaths.length, "files to extract")

          for (let i = 0; i < filePaths.length; i++) {
            const filePath = filePaths[i]
            try {
              const cleanPath = filePath.replace(/^\.\//, "")
              const content = await sandbox.files.read(`/home/user/${cleanPath}`, { format: "text" })

              if (cleanPath === "package.json" || cleanPath.endsWith(".json")) {
                try {
                  const parsed = JSON.parse(content)
                  files[cleanPath] = JSON.stringify(parsed, null, 2)
                  console.log(`[v0] Validated and formatted JSON file: ${cleanPath}`)
                } catch (jsonError) {
                  console.error(`[v0] Invalid JSON in ${cleanPath}:`, jsonError)
                  if (cleanPath === "package.json") {
                    const defaultPackageJson = {
                      name: "nextjs-app",
                      private: true,
                      scripts: {
                        dev: "next dev -p 3000 -H 0.0.0.0",
                        build: "next build",
                        start: "next start -p 3000 -H 0.0.0.0",
                      },
                      dependencies: {
                        next: "14.2.3",
                        react: "18.2.0",
                        "react-dom": "18.2.0",
                      },
                    }
                    files[cleanPath] = JSON.stringify(defaultPackageJson, null, 2)
                    console.log(`[v0] Used fallback package.json due to corruption`)
                  } else {
                    files[cleanPath] = content
                  }
                }
              } else {
                files[cleanPath] = typeof content === "string" ? content : String(content)
              }

              console.log(`[v0] Extracted file ${i + 1}/${filePaths.length}:`, cleanPath)
            } catch (error) {
              console.log("[v0] Could not read file:", filePath, error)
            }
          }

          console.log("[v0] Successfully extracted", Object.keys(files).length, "files")
          console.log("[v0] Keeping sandbox alive for potential reuse")

          return NextResponse.json({
            success: true,
            files,
            fileCount: Object.keys(files).length,
          })
        } catch (error: any) {
          console.error("[v0] Error extracting files:", error)
          return NextResponse.json(
            {
              success: false,
              error: "Failed to extract files from sandbox",
              details: error.message,
              sandboxId: sid,
            },
            { status: 500 },
          )
        }
      }

      case "processFiles": {
        const sid = bodySandboxId
        if (!sid) throw new Error("sandboxId manquant")

        console.log("[v0] Processing files for deployment from sandbox:", sid)

        try {
          // First extract files using existing logic
          const extractResponse = await fetch(`${req.url}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "getFiles", sandboxId: sid }),
          })

          const extractResult = await extractResponse.json()

          if (!extractResult.success) {
            throw new Error(`Failed to extract files: ${extractResult.error}`)
          }

          const rawFiles = extractResult.files
          const processedFiles: Record<string, { content: string; encoding: string }> = {}

          for (const [filePath, content] of Object.entries(rawFiles)) {
            const fileContent = content as string

            if (typeof fileContent !== "string") {
              console.error(`[v0] File ${filePath} has invalid content type:`, typeof fileContent)
              continue
            }

            if (filePath === "package.json") {
              try {
                JSON.parse(fileContent)
                console.log(`[v0] package.json is valid JSON`)
              } catch (e) {
                console.error(`[v0] package.json is invalid JSON, content:`, fileContent.substring(0, 100))
                throw new Error(`package.json contains invalid JSON: ${e}`)
              }
            }

            processedFiles[filePath] = {
              content: Buffer.from(fileContent, "utf8").toString("base64"),
              encoding: "base64",
            }

            console.log(
              `[v0] Processed file: ${filePath} (${fileContent.length} chars -> ${processedFiles[filePath].content.length} base64 chars)`,
            )
          }

          console.log("[v0] Successfully processed", Object.keys(processedFiles).length, "files for deployment")

          return NextResponse.json({
            success: true,
            files: processedFiles,
            fileCount: Object.keys(processedFiles).length,
          })
        } catch (error: any) {
          console.error("[v0] Error processing files:", error)
          return NextResponse.json(
            {
              success: false,
              error: "Failed to process files for deployment",
              details: error.message,
              sandboxId: sid,
            },
            { status: 500 },
          )
        }
      }

      case "checkStatus": {
        const sid = bodySandboxId
        if (!sid) throw new Error("sandboxId manquant")

        console.log("[v0] Checking sandbox status:", sid)

        try {
          const sandbox = await e2b.Sandbox.connect(sid, {
            apiKey,
            timeoutMs: 30000, // Short timeout for status check
          })

          return NextResponse.json({
            success: true,
            status: "active",
            sandboxId: sid,
          })
        } catch (error: any) {
          console.log("[v0] Sandbox status check failed:", error.message)
          return NextResponse.json({
            success: false,
            status: "inactive",
            error: error.message,
            sandboxId: sid,
          })
        }
      }

      default:
        return NextResponse.json({ error: "Action inconnue" }, { status: 400 })
    }
  } catch (e: any) {
    console.error("[v0] Sandbox API error:", e)
    return NextResponse.json(
      {
        error: e.message || "Une erreur inconnue s'est produite",
        details: e.toString(),
      },
      { status: 500 },
    )
  }
}
