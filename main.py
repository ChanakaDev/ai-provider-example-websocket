import asyncio
import base64
import json
import os
from typing import AsyncIterable
from dotenv import load_dotenv
from fastapi import FastAPI, Query, WebSocket
from agent import root_agent

# Load API Keys
load_dotenv()

APP_NAME = "AI Agent Streaming example"
session_service = InMemorySessionService()

def start_agent_session(session_id, is_audio=False):
    """Starts an agent session"""
    try:
        # Create a Session
        session = session_service.create_session(
            app_name=APP_NAME,
            user_id=session_id,
            session_id=session_id,
        )
        
        # Create a Runner
        runner = Runner(
            app_name=APP_NAME,
            agent=root_agent,
            session_service=session_service,
        )
        
        # Set response modality
        modality = "AUDIO" if is_audio else "TEXT"
        
        # Create speech config with voice settings
        speech_config = types.SpeechConfig(
            voice_config=types.VoiceConfig(
                # Available voices: Arbor, Breeze, Cove, Ember, Juniper, Maple, Sol
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Breeze")
            )
        )
        
        # Create run config with enhanced settings for better audio handling
        config = {
            "response_modalities": [modality],
            "speech_config": speech_config,
            "input_audio_transcription": {}  # Enable transcription for better processing
        }
        
        # Add output_audio_transcription when audio is enabled to get both audio and text
        if is_audio:
            config["output_audio_transcription"] = {}
            
        run_config = RunConfig(**config)
        
        # Create a LiveRequestQueue for this session
        live_request_queue = LiveRequestQueue()
        
        # Start agent session
        live_events = runner.run_live(
            session=session,
            live_request_queue=live_request_queue,
            run_config=run_config,
        )
        
        return live_events, live_request_queue
        
    except Exception as e:
        print(f"Error starting agent session: {e}")
        raise e

async def agent_to_client_messaging(
    websocket: WebSocket, live_events: AsyncIterable[Event | None]
):
    """Agent to client communication with enhanced audio handling"""
    try:
        async for event in live_events:
            if event is None:
                continue
            
            # Handle turn completion and interruption
            if event.turn_complete or event.interrupted:
                message = {
                    "turn_complete": event.turn_complete,
                    "interrupted": event.interrupted,
                }
                await websocket.send_text(json.dumps(message))
                print(f"[AGENT TO CLIENT]: {message}")
                continue
            
            # Process content parts
            part = event.content and event.content.parts and event.content.parts[0]
            if not part:
                continue
            
            # Make sure we have a valid Part
            if not isinstance(part, types.Part):
                continue
            
            # Handle text responses (only send partial responses for streaming)
            if part.text and event.partial:
                message = {
                    "mime_type": "text/plain",
                    "data": part.text,
                    "role": "model",
                }
                await websocket.send_text(json.dumps(message))
                print(f"[AGENT TO CLIENT]: text/plain: {part.text}")
            
            # Handle audio responses with enhanced checking
            is_audio = (
                part.inline_data
                and part.inline_data.mime_type
                and part.inline_data.mime_type.startswith("audio/")
            )
            
            if is_audio:
                audio_data = part.inline_data.data
                if audio_data:
                    # Ensure we're sending the correct MIME type
                    mime_type = part.inline_data.mime_type
                    message = {
                        "mime_type": mime_type,  # Use the actual MIME type from AI Agent
                        "data": base64.b64encode(audio_data).decode("ascii"),
                        "role": "model",
                    }
                    await websocket.send_text(json.dumps(message))
                    print(f"[AGENT TO CLIENT]: {mime_type}: {len(audio_data)} bytes")
                    
    except Exception as e:
        print(f"Error in agent_to_client_messaging: {e}")

async def client_to_agent_messaging(
    websocket: WebSocket, live_request_queue: LiveRequestQueue
):
    """Client to agent communication with enhanced audio handling"""
    try:
        while True:
            # Decode JSON message
            message_json = await websocket.receive_text()
            message = json.loads(message_json)
            mime_type = message["mime_type"]
            data = message["data"]
            role = message.get("role", "user")  # Default to 'user' if role is not provided
            
            # Send the message to the agent
            if mime_type == "text/plain":
                # Send a text message
                content = types.Content(role=role, parts=[types.Part.from_text(text=data)])
                live_request_queue.send_content(content=content)
                print(f"[CLIENT TO AGENT]: text: {data}")
                
            elif mime_type == "audio/pcm" or mime_type.startswith("audio/"):
                # Send audio data with proper MIME type handling
                decoded_data = base64.b64decode(data)
                
                # Send the audio data - AI Agent handles transcription automatically
                # when input_audio_transcription is enabled in the config
                live_request_queue.send_realtime(
                    types.Blob(data=decoded_data, mime_type=mime_type)
                )
                print(f"[CLIENT TO AGENT]: {mime_type}: {len(decoded_data)} bytes")
                
            else:
                print(f"[WARNING]: Unsupported mime type: {mime_type}")
                # Don't raise error, just log and continue
                
    except Exception as e:
        print(f"Error in client_to_agent_messaging: {e}")

# FastAPI web app
app = FastAPI()

@app.get("/")
async def root():
    """Health check endpoint"""
    return {"status": "AI Agent Server Running", "version": "1.0"}

@app.websocket("/ws/{session_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    session_id: str,
    is_audio: str = Query(...),
):
    """Client websocket endpoint with improved error handling"""
    try:
        # Wait for client connection
        await websocket.accept()
        print(f"Client #{session_id} connected, audio mode: {is_audio}")
        
        # Start agent session
        live_events, live_request_queue = start_agent_session(
            session_id, is_audio == "true"
        )
        
        # Start tasks with error handling
        agent_to_client_task = asyncio.create_task(
            agent_to_client_messaging(websocket, live_events)
        )
        
        client_to_agent_task = asyncio.create_task(
            client_to_agent_messaging(websocket, live_request_queue)
        )
        
        # Wait for either task to complete (or fail)
        done, pending = await asyncio.wait(
            [agent_to_client_task, client_to_agent_task],
            return_when=asyncio.FIRST_COMPLETED
        )
        
        # Cancel remaining tasks
        for task in pending:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
                
    except Exception as e:
        print(f"WebSocket error for client #{session_id}: {e}")
    finally:
        print(f"Client #{session_id} disconnected")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    certfile = os.getenv("SSL_CERTFILE")
    keyfile = os.getenv("SSL_KEYFILE")
    ca_certs = os.getenv("SSL_CA_CERTS")
    
    uvicorn_kwargs = {}
    if certfile and keyfile:
        uvicorn_kwargs.update({
            "ssl_certfile": certfile,
            "ssl_keyfile": keyfile,
        })
        if ca_certs:
            uvicorn_kwargs["ssl_ca_certs"] = ca_certs
    
    uvicorn.run(app, host="0.0.0.0", port=port, **uvicorn_kwargs)