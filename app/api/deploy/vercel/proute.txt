import { type NextRequest, NextResponse } from "next/server"

export async function POST(request: NextRequest) {
  try {
    const { files, projectName, token, sandboxId } = await request.json()

    console.log("[v0] Starting Vercel deployment for project:", projectName)
    console.log("[v0] Sandbox ID:", sandboxId)

    let deployFiles = files
    if (sandboxId && (!files || Object.keys(files).length === 0)) {
      console.log("[v0] No files provided, extracting and processing from sandbox:", sandboxId)

      const extractResponse = await fetch(`${request.nextUrl.origin}/api/sandbox`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "processFiles",
          sandboxId: sandboxId,
        }),
      })

      const extractData = await extractResponse.json()

      if (!extractData.success) {
        throw new Error(`Failed to process files from sandbox: ${extractData.error}`)
      }

      deployFiles = extractData.files
      console.log("[v0] Processed", extractData.fileCount, "files from sandbox")
    }

    console.log("[v0] Files to deploy:", Object.keys(deployFiles || {}))

    if (!deployFiles || Object.keys(deployFiles).length === 0) {
      throw new Error("No files available for deployment")
    }

    if (!token) {
      throw new Error("Vercel access token is required")
    }

    const requiredFiles = ["package.json"]
    const missingFiles = requiredFiles.filter((file) => !deployFiles[file])
    if (missingFiles.length > 0) {
      console.warn("[v0] Missing required files:", missingFiles)
    }

    const deploymentResponse = await fetch("https://api.vercel.com/v13/deployments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: projectName,
        files: Object.entries(deployFiles).map(([path, fileData]) => {
          let fileContent: string

          if (typeof fileData === "object" && fileData !== null && "content" in fileData) {
            const processedFile = fileData as { content: string; encoding: string }
            console.log("[v0] Using pre-processed file", path, "with encoding:", processedFile.encoding)

            // Use raw content directly, not base64
            if (processedFile.encoding === "base64") {
              // If it's already base64, decode it first
              fileContent = Buffer.from(processedFile.content, "base64").toString("utf8")
            } else {
              fileContent = processedFile.content
            }
          } else {
            // Direct file content
            fileContent = fileData as string
          }

          // Special validation for package.json
          if (path === "package.json") {
            try {
              JSON.parse(fileContent)
              console.log("[v0] package.json is valid JSON")
            } catch (e) {
              console.error("[v0] Invalid package.json detected, using fallback")
              fileContent = JSON.stringify(
                {
                  name: projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
                  version: "1.0.0",
                  private: true,
                  scripts: {
                    dev: "next dev",
                    build: "next build",
                    start: "next start",
                    lint: "next lint",
                  },
                  dependencies: {
                    next: "14.0.0",
                    react: "^18",
                    "react-dom": "^18",
                  },
                  devDependencies: {
                    "@types/node": "^20",
                    "@types/react": "^18",
                    "@types/react-dom": "^18",
                    eslint: "^8",
                    "eslint-config-next": "14.0.0",
                    typescript: "^5",
                  },
                },
                null,
                2,
              )
            }
          }

          console.log(
            "[v0] File",
            path,
            "content length:",
            fileContent.length,
            "first 50 chars:",
            fileContent.substring(0, 50),
          )

          return {
            file: path,
            data: fileContent, // Raw content, not base64
          }
        }),
        projectSettings: {
          framework: "nextjs",
        },
      }),
    })

    const deploymentData = await deploymentResponse.json()
    console.log("[v0] Vercel API response:", deploymentData)

    if (!deploymentResponse.ok) {
      const errorMessage = deploymentData.error?.message || deploymentData.message || "Unknown Vercel API error"
      console.error("[v0] Vercel deployment failed:", errorMessage)
      throw new Error(`Vercel API Error: ${errorMessage}`)
    }

    if (!deploymentData.url) {
      console.error("[v0] No URL in deployment response:", deploymentData)
      throw new Error("Deployment completed but no URL was returned")
    }

    console.log("[v0] Deployment successful:", deploymentData.url)

    return NextResponse.json({
      success: true,
      url: `https://${deploymentData.url}`,
      deploymentId: deploymentData.id,
      projectId: deploymentData.projectId,
      filesDeployed: Object.keys(deployFiles).length,
    })
  } catch (error: any) {
    console.error("[v0] Deployment error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Deployment failed",
        details: error.toString(),
      },
      { status: 400 },
    )
  }
}
