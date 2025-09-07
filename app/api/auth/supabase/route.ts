import { type NextRequest, NextResponse } from "next/server"

export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json()

    if (!token) {
      return NextResponse.json({ success: false, error: "Token is required" }, { status: 400 })
    }

    // Verify token by getting user organizations
    const orgsResponse = await fetch("https://api.supabase.com/v1/organizations", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    })

    if (!orgsResponse.ok) {
      return NextResponse.json({ success: false, error: "Invalid token" }, { status: 401 })
    }

    const orgsData = await orgsResponse.json()

    if (!orgsData || orgsData.length === 0) {
      return NextResponse.json({ success: false, error: "No organizations found" }, { status: 400 })
    }

    // Create new project
    const projectResponse = await fetch("https://api.supabase.com/v1/projects", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `v0-project-${Date.now()}`,
        organization_id: orgsData[0].id,
        plan: "free",
        region: "us-east-1",
      }),
    })

    const projectData = await projectResponse.json()

    const connection = {
      type: "supabase" as const,
      token,
      userId: orgsData[0].id,
      username: orgsData[0].name,
      email: orgsData[0].name,
      connectedAt: new Date().toISOString(),
    }

    const supabaseProject = {
      id: projectData.id,
      name: projectData.name,
      url: `https://${projectData.id}.supabase.co`,
      anonKey: projectData.anon_key,
      serviceRoleKey: projectData.service_role_key,
      region: projectData.region,
    }

    return NextResponse.json({ success: true, connection, project: supabaseProject })
  } catch (error) {
    return NextResponse.json({ success: false, error: "Authentication failed" }, { status: 400 })
  }
}
