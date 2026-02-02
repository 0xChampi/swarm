import { NextRequest, NextResponse } from 'next/server'

/**
 * Clippio Video Generation Delegation Endpoint
 *
 * Handles video generation requests from AZOKA bot.
 * Uses Replicate API for two-step video generation:
 * 1. Generate image from prompt using SDXL
 * 2. Animate image using Stable Video Diffusion
 */

interface DelegateRequest {
  task_description: string
  priority?: 'low' | 'medium' | 'high' | 'critical'
  expected_duration?: string
  user_id?: string
}

interface ReplicateResponse {
  id: string
  urls: {
    get: string
    cancel?: string
  }
  status: 'starting' | 'processing' | 'succeeded' | 'failed'
  output?: any
  error?: string
}

export async function POST(request: NextRequest) {
  try {
    const body: DelegateRequest = await request.json()
    const { task_description, priority = 'medium', expected_duration, user_id } = body

    if (!task_description) {
      return NextResponse.json(
        { error: 'task_description is required' },
        { status: 400 }
      )
    }

    const replicateToken = process.env.REPLICATE_API_TOKEN
    if (!replicateToken) {
      return NextResponse.json(
        {
          error: 'REPLICATE_API_TOKEN not configured',
          message: 'Video generation requires Replicate API token to be set in environment variables'
        },
        { status: 500 }
      )
    }

    console.log(`[Clippio] Video generation request: "${task_description.substring(0, 50)}..." from user ${user_id || 'unknown'}`)

    // Step 1: Generate image from task description using SDXL
    const imagePrompt = `${task_description}, memecoin style, digital art, vibrant colors, masterpiece quality, 16:9 aspect ratio`
    const negativePrompt = 'low quality, blurry, distorted, ugly, text, watermark, deformed'

    const headers = {
      'Authorization': `Token ${replicateToken}`,
      'Content-Type': 'application/json'
    }

    // Create image generation prediction
    const imgResponse = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: '39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b', // SDXL
        input: {
          prompt: imagePrompt,
          negative_prompt: negativePrompt,
          width: 1024,
          height: 576, // 16:9 for video
          num_outputs: 1,
          num_inference_steps: 25,
          guidance_scale: 7.5
        }
      })
    })

    if (!imgResponse.ok) {
      const errorText = await imgResponse.text()
      console.error('[Clippio] Image generation API error:', errorText)
      return NextResponse.json(
        {
          error: 'Image generation failed',
          message: `Replicate API error: ${errorText.substring(0, 100)}`
        },
        { status: 500 }
      )
    }

    const imgPrediction: ReplicateResponse = await imgResponse.json()
    const predictionUrl = imgPrediction.urls.get

    // Poll for image completion (max 90 seconds)
    let imageUrl: string | null = null
    for (let i = 0; i < 45; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000)) // 2 second delay

      const pollResponse = await fetch(predictionUrl, { headers })
      if (!pollResponse.ok) continue

      const result: ReplicateResponse = await pollResponse.json()

      if (result.status === 'succeeded' && result.output) {
        imageUrl = Array.isArray(result.output) ? result.output[0] : result.output
        break
      } else if (result.status === 'failed') {
        return NextResponse.json(
          {
            error: 'Image generation failed',
            message: result.error || 'Unknown error during image generation'
          },
          { status: 500 }
        )
      }
    }

    if (!imageUrl) {
      return NextResponse.json(
        {
          error: 'Image generation timed out',
          message: 'Image generation took longer than 90 seconds'
        },
        { status: 408 }
      )
    }

    console.log(`[Clippio] Image generated successfully: ${imageUrl.substring(0, 50)}...`)

    // Step 2: Generate video from image using Stable Video Diffusion
    const videoResponse = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: '3f0457e4619daac51203dedb472816fd4af51f3149fa7a9e0b5ffcf1b8172438', // Stable Video Diffusion
        input: {
          input_image: imageUrl,
          motion_bucket_id: 127, // Amount of motion
          fps: 6,
          cond_aug: 0.02
        }
      })
    })

    if (!videoResponse.ok) {
      const errorText = await videoResponse.text()
      console.error('[Clippio] Video generation API error:', errorText)
      return NextResponse.json(
        {
          error: 'Video generation failed',
          message: `Replicate API error: ${errorText.substring(0, 100)}`
        },
        { status: 500 }
      )
    }

    const videoPrediction: ReplicateResponse = await videoResponse.json()
    const videoPredictionUrl = videoPrediction.urls.get

    // Poll for video completion (max 180 seconds)
    let videoUrl: string | null = null
    for (let i = 0; i < 90; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000)) // 2 second delay

      const pollResponse = await fetch(videoPredictionUrl, { headers })
      if (!pollResponse.ok) continue

      const result: ReplicateResponse = await pollResponse.json()

      if (result.status === 'succeeded' && result.output) {
        videoUrl = result.output
        break
      } else if (result.status === 'failed') {
        return NextResponse.json(
          {
            error: 'Video generation failed',
            message: result.error || 'Unknown error during video generation'
          },
          { status: 500 }
        )
      }
    }

    if (!videoUrl) {
      return NextResponse.json(
        {
          error: 'Video generation timed out',
          message: 'Video generation took longer than 180 seconds'
        },
        { status: 408 }
      )
    }

    console.log(`[Clippio] Video generated successfully: ${videoUrl}`)

    // Return success with task ID and video URL
    return NextResponse.json({
      success: true,
      task_id: videoPrediction.id,
      status: 'completed',
      result: {
        video_url: videoUrl,
        image_url: imageUrl
      },
      message: 'Video generated successfully',
      priority,
      user_id
    })

  } catch (error: any) {
    console.error('[Clippio] Unexpected error:', error)
    return NextResponse.json(
      {
        error: 'Unexpected error',
        message: error.message || error.toString()
      },
      { status: 500 }
    )
  }
}
