import { type NextRequest, NextResponse } from "next/server"

export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json()

    if (!token) {
      return NextResponse.json({ success: false, error: "Token is required" }, { status: 400 })
    }

    // Verify token by getting user info
    const userResponse = await fetch("https://api.vercel.com/v2/user", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    if (!userResponse.ok) {
      return NextResponse.json({ success: false, error: "Invalid token" }, { status: 401 })
    }

    const userData = await userResponse.json()

    const connection = {
      type: "vercel" as const,
      token,
      userId: userData.user.id,
      username: userData.user.username,
      email: userData.user.email,
      connectedAt: Date.now(),
    }

    return NextResponse.json({ success: true, connection })
  } catch (error) {
    return NextResponse.json({ success: false, error: "Authentication failed" }, { status: 400 })
  }
}
