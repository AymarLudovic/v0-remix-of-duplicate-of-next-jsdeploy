import { NextResponse } from "next/server"
import { JSDOM } from "jsdom"

async function fetchUrlContent(url: string): Promise<{ success: boolean; content: string }> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        DNT: "1",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
      timeout: 10000,
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const content = await response.text()
    return { success: true, content }
  } catch (error) {
    console.error(`Failed to fetch ${url}:`, error)
    return { success: false, content: "" }
  }
}

function detectAnimationLibrary(content: string): { isAnimation: boolean; library?: string; confidence: number } {
  const patterns = [
    { regex: /gsap|tweenmax|tweenlite|timelinemax|timelinelite/gi, library: "GSAP", confidence: 90 },
    { regex: /new THREE\.|THREE\.Scene|THREE\.WebGLRenderer/gi, library: "Three.js", confidence: 95 },
    { regex: /anime\(|anime\.js/gi, library: "Anime.js", confidence: 85 },
    { regex: /lottie|bodymovin/gi, library: "Lottie", confidence: 90 },
    { regex: /framer-motion|motion\./gi, library: "Framer Motion", confidence: 85 },
    { regex: /aos\.init|AOS\./gi, library: "AOS", confidence: 80 },
    { regex: /scrollmagic/gi, library: "ScrollMagic", confidence: 80 },
    { regex: /@keyframes|animation:|transform:|transition:/gi, library: "CSS Animations", confidence: 70 },
  ]

  for (const pattern of patterns) {
    if (pattern.regex.test(content)) {
      return { isAnimation: true, library: pattern.library, confidence: pattern.confidence }
    }
  }

  return { isAnimation: false, confidence: 0 }
}

function processCSS(css: string, usedClasses: Set<string>): string {
  return css || ""
}

function processHTML(html: string): { cleanHTML: string; usedClasses: Set<string> } {
  const usedClasses = new Set<string>()

  const dom = new JSDOM(html)
  const document = dom.window.document

  // Extract all classes
  document.querySelectorAll("[class]").forEach((el) => {
    const classList = (el as HTMLElement).className
    if (typeof classList === "string") {
      classList.split(/\s+/).forEach((cls) => {
        if (cls.trim()) usedClasses.add(cls.trim())
      })
    }
  })

  return { cleanHTML: html, usedClasses }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    let urlToAnalyze = body.url as string

    if (!urlToAnalyze) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 })
    }

    // Normalize URL
    if (!/^https?:\/\//i.test(urlToAnalyze)) {
      urlToAnalyze = "https://" + urlToAnalyze
    }

    console.log(`[v0] Starting analysis of: ${urlToAnalyze}`)

    // Fetch main HTML
    const mainResponse = await fetchUrlContent(urlToAnalyze)
    if (!mainResponse.success) {
      throw new Error("Could not fetch the main HTML content")
    }

    const dom = new JSDOM(mainResponse.content)
    const document = dom.window.document
    const baseURL = new URL(urlToAnalyze).origin

    console.log(`[v0] Base URL: ${baseURL}`)

    // Extract metadata
    const title = document.title || "Untitled"
    const description = document.querySelector('meta[name="description"]')?.getAttribute("content") || ""

    // Process HTML and extract classes
    const { cleanHTML, usedClasses } = processHTML(document.body.innerHTML)
    console.log(`[v0] Extracted ${usedClasses.size} CSS classes`)

    // Extract CSS sources
    const cssSources = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .map((el) => {
        try {
          return new URL((el as HTMLLinkElement).href, baseURL).href
        } catch {
          return null
        }
      })
      .filter(Boolean) as string[]

    console.log(`[v0] Found ${cssSources.length} CSS files`)

    // Fetch external CSS
    const cssFetches = await Promise.all(
      cssSources.map(async (href) => {
        const result = await fetchUrlContent(href)
        return { href, ...result }
      }),
    )

    // Extract inline CSS
    const inlineCss = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent || "")
      .filter(Boolean)

    // Combine and process CSS
    const rawCSS = [
      ...cssFetches.filter((c) => c.success).map((c) => `/* From: ${c.href} */\n${c.content}`),
      ...inlineCss.map((css, i) => `/* Inline style ${i + 1} */\n${css}`),
    ].join("\n\n")

    const fullCSS = rawCSS
    console.log(`[v0] Full CSS: ${fullCSS.length} characters`)

    // Extract JavaScript sources
    const scriptSources = Array.from(document.querySelectorAll("script[src]"))
      .map((el) => {
        try {
          return new URL((el as HTMLScriptElement).src, baseURL).href
        } catch {
          return null
        }
      })
      .filter(Boolean) as string[]

    console.log(`[v0] Found ${scriptSources.length} JS files`)

    // Fetch external JS and detect animations
    const scriptFetches = await Promise.all(
      scriptSources.map(async (src) => {
        const result = await fetchUrlContent(src)
        const animationInfo = result.success
          ? detectAnimationLibrary(result.content)
          : { isAnimation: false, confidence: 0 }
        return { src, ...result, ...animationInfo }
      }),
    )

    // Extract inline JS
    const inlineJs = Array.from(document.querySelectorAll("script:not([src])"))
      .map((s) => s.textContent || "")
      .filter(Boolean)

    // Combine JS
    const fullJS = [
      ...scriptFetches.filter((s) => s.success).map((s) => `/* From: ${s.src} */\n${s.content}`),
      ...inlineJs.map((js, i) => `/* Inline script ${i + 1} */\n${js}`),
    ].join("\n\n")

    // Detect animation files
    const animationFiles = scriptFetches
      .filter((s) => s.isAnimation)
      .map((s) => ({
        url: s.src,
        content: s.content,
        type: "js" as const,
        isAnimation: true,
        library: s.library,
        confidence: s.confidence || 0,
      }))

    // Extract required CDN URLs
    const requiredCdnUrls = [
      ...cssSources.filter((url) => url.includes("cdn") || url.includes("googleapis")),
      ...scriptSources.filter((url) => url.includes("cdn") || url.includes("googleapis")),
    ]

    console.log(`[v0] Analysis complete. Animation files: ${animationFiles.length}`)

    return NextResponse.json({
      title,
      description,
      fullHTML: cleanHTML,
      fullCSS: fullCSS,
      fullJS: fullJS,
      baseURL,
      animationFiles,
      requiredCdnUrls,
      usedClasses: Array.from(usedClasses),
      techGuesses: [
        ...animationFiles.map((f) => f.library).filter(Boolean),
        fullCSS.includes("tailwind") ? "Tailwind CSS" : null,
        fullJS.includes("react") ? "React" : null,
        fullJS.includes("vue") ? "Vue.js" : null,
      ].filter(Boolean),
      stylesheets: cssSources.length,
      internalLinks: document.querySelectorAll('a[href^="/"], a[href^="./"], a[href^="../"]').length,
      externalLinks: document.querySelectorAll('a[href^="http"]').length,
      images: Array.from(document.querySelectorAll("img")).map((img) => (img as HTMLImageElement).src),
      openGraphTags: document.querySelectorAll('meta[property^="og:"]').length,
    })
  } catch (err: any) {
    console.error("[v0] Analysis error:", err)
    return NextResponse.json(
      {
        error: `Analysis failed: ${err.message}`,
        details: err.stack,
      },
      { status: 500 },
    )
  }
     }
