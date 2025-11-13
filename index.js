const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);

// Middleware to parse JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// AI Agent Websocket Base URL
const ai_agent_base_url = 'ai-agent-url.dev';

// SmartPBX Websocket Base URL
const smartpbx_base_url = 'smartpbx-url.dev';

// Accurate ITU-T G.711 μ-law conversion tables
const MU_LAW_MAX = 0x1FFF;
const MU_LAW_BIAS = 0x84;

// Convert 16-bit PCM (base64) → μ-law (base64)
function convertPCMToMulaw(pcmBase64) {
    try {
        const pcmBuffer = Buffer.from(pcmBase64, 'base64');
        const mulawBuffer = Buffer.alloc(pcmBuffer.length / 2);

        for (let i = 0, j = 0; i < pcmBuffer.length; i += 2, j++) {
            const sample = pcmBuffer.readInt16LE(i);
            let sign = (sample >> 8) & 0x80;
            let magnitude = Math.abs(sample);

            if (magnitude > MU_LAW_MAX) magnitude = MU_LAW_MAX;
            magnitude += MU_LAW_BIAS;

            let exponent = 7;
            for (let expMask = 0x4000; (magnitude & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) { }

            let mantissa = (magnitude >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
            let mulaw = ~(sign | (exponent << 4) | mantissa);

            mulawBuffer[j] = mulaw & 0xFF;
        }

        return mulawBuffer.toString('base64');
    } catch (err) {
        console.error('PCM→μ-law conversion error:', err);
        return null;
    }
}

// Convert μ-law (base64) → 16-bit PCM (base64)
function convertMulawToPCM(mulawBase64) {
    try {
        const mulawBuffer = Buffer.from(mulawBase64, 'base64');
        const pcmBuffer = Buffer.alloc(mulawBuffer.length * 2);

        for (let i = 0; i < mulawBuffer.length; i++) {
            let mulawByte = ~mulawBuffer[i];
            let sign = mulawByte & 0x80;
            let exponent = (mulawByte >> 4) & 0x07;
            let mantissa = mulawByte & 0x0F;

            let magnitude = ((mantissa << 3) + 0x84) << exponent;
            magnitude -= MU_LAW_BIAS;

            let sample = sign ? -magnitude : magnitude;
            pcmBuffer.writeInt16LE(sample, i * 2);
        }

        return pcmBuffer.toString('base64');
    } catch (err) {
        console.error('μ-law→PCM conversion error:', err);
        return null;
    }
}

// Enhanced sample rate conversion function
function resamplePCM(pcmBase64, sourceRate, targetRate) {
    try {
        if (sourceRate === targetRate) {
            return pcmBase64;
        }

        const pcmBuffer = Buffer.from(pcmBase64, 'base64');
        const samples = pcmBuffer.length / 2; // 16-bit samples
        const ratio = sourceRate / targetRate;
        const outputSamples = Math.floor(samples / ratio);
        const outputBuffer = Buffer.alloc(outputSamples * 2);

        for (let i = 0; i < outputSamples; i++) {
            const sourceIndex = Math.floor(i * ratio) * 2;
            const sample = pcmBuffer.readInt16LE(sourceIndex);
            outputBuffer.writeInt16LE(sample, i * 2);
        }

        return outputBuffer.toString('base64');
    } catch (error) {
        console.error('Sample rate conversion error:', error);
        return pcmBase64; // Return original on error
    }
}

// SbxML webhook: use Connect with your actual ngrok URL
app.post('/', (req, res) => {
    try {
        res.type('text/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${smartpbx_base_url}/media-stream" />
    </Connect>
</Response>`);
    } catch (error) {
        console.error('SbxML webhook error:', error);
        res.status(500).send('Internal Server Error');
    }
});

// WS server for SmartPBX Media Streams
const smartpbxWss = new WebSocket.Server({ server, path: '/media-stream' });

smartpbxWss.on('connection', (smartpbxWs, req) => {
    console.log('SmartPBX connected');

    // Agent WebSocket URL - make sure this matches your Python server
    const agentUrl = `ws://${ai_agent_base_url}/ws/test123?is_audio=true`;
    // Connect to agent with timeout
    const agentWs = new WebSocket(agentUrl);

    // ################################
    // 1. Call Handling Variables
    // ################################
    let callId = null;
    let accountId = null;
    let agentReady = false;
    let callActive = false;
    let hasSpoken = false; // Track if agent has responded with audio

    // Store SmartPBX audio format
    let smartpbxEncoding = null;
    let smartpbxSampleRate = null;

    // Add connection timeout
    const connectionTimeout = setTimeout(() => {
        console.error('Agent connection timeout');
        if (smartpbxWs.readyState === WebSocket.OPEN) {
            smartpbxWs.close();
        }
    }, 10000); // 10 second timeout

    // ################################
    // 2. Agent WebSocket Section
    // ################################
    agentWs.on('open', () => {
        clearTimeout(connectionTimeout);
        console.log('Agent WS connected');
        agentReady = true;
    });

    agentWs.on('message', (data) => {
        // Forward agent messages to SmartPBX
        try {
            const msg = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());

            // Handle different message types from agent
            if (msg.mime_type && msg.data && callId && accountId && callActive) {
                if (msg.mime_type.startsWith("audio/")) {
                    // Handle different audio formats from the agent
                    let pcmData = msg.data;
                    let outgoingPayload = null;

                    // Convert depending on client format
                    if (smartpbxEncoding === "g711_ulaw") {
                        // Resample from 24kHz to 8kHz for SmartPBX
                        pcmData = resamplePCM(pcmData, 24000, 8000);
                        // Convert PCM to μ-law for SmartPBX
                        outgoingPayload = convertPCMToMulaw(pcmData);
                        console.log(`[AGENT->SMARTPBX]: PCM16 24kHz → μ-law 8kHz`);
                    } else if (smartpbxEncoding === "pcm16") {
                        // Direct pass-through if PCM16
                        outgoingPayload = pcmData;
                        console.log(`[AGENT->SMARTPBX]: PCM16 24kHz passthrough`);
                    }

                    if (outgoingPayload) {
                        const smartpbxMedia = {
                            event: 'media',
                            callId,
                            accountId,
                            media: { payload: outgoingPayload }
                        };
                        if (smartpbxWs.readyState === WebSocket.OPEN) {
                            smartpbxWs.send(JSON.stringify(smartpbxMedia));
                            hasSpoken = true;
                            console.log(`[AGENT->SMARTPBX]: Sent audio`);
                        }
                    }
                } else if (msg.mime_type === "text/plain") {
                    // Log text responses for debugging
                    console.log(`[AGENT TEXT]: ${msg.data}`);
                }
            }

            // Handle control messages
            if (msg.turn_complete) {
                console.log('[AGENT]: Turn complete');
                if (!hasSpoken) {
                    console.log('[WARNING]: Agent completed turn but no audio was sent to caller');
                }
            }

            if (msg.interrupted) {
                console.log('[AGENT]: Interrupted');
            }

        } catch (e) {
            console.error('Agent message parse error', e);
        }
    });

    agentWs.on('close', () => {
        console.log('Agent WS closed');
        if (smartpbxWs.readyState === WebSocket.OPEN) {
            smartpbxWs.close();
        }
    });

    agentWs.on('error', (err) => {
        clearTimeout(connectionTimeout);
        console.error('Agent WS error:', err);
        // Send error message back to SmartPBX
        if (smartpbxWs.readyState === WebSocket.OPEN) {
            smartpbxWs.close();
        }
    });

    // ################################
    // 3. SmartPBX WebSocket Section
    // ################################
    smartpbxWs.on('message', (message) => {
        try {
            // Important: This will be used to switch between different events
            const msg = JSON.parse(message);

            // ################################
            // 4. Handle Specific SmartPBX Events
            // ################################
            switch (msg.event) {
                // Important: This is not given in the SmartPBX docs
                case 'connected':
                    console.log('SmartPBX connected event');
                    break;

                case 'start':
                    // Initialize callId when call starts
                    // Important: We use this to send media to the agent
                    callId = msg.start.callId;
                    accountId = msg.start.accountId;
                    callActive = true;
                    hasSpoken = false;
                    console.log('Stream started call ', callId, ' for account ', accountId);

                    // Detect media format from start event
                    if (msg.start.mediaFormat) {
                        smartpbxEncoding = msg.start.mediaFormat.encoding;
                        smartpbxSampleRate = parseInt(msg.start.mediaFormat.sampleRate, 10);
                        console.log(`[SMARTPBX FORMAT]: encoding=${smartpbxEncoding}, sampleRate=${smartpbxSampleRate}`);
                    }

                    // Send initial greeting to agent when call starts
                    if (agentReady && agentWs.readyState === WebSocket.OPEN) {
                        console.log('[INIT]: Sending greeting to agent');
                        agentWs.send(JSON.stringify({
                            mime_type: "text/plain",
                            data: "Hello! A new caller has connected. Please greet them.",
                            role: "user"
                        }));
                    }
                    break;

                case 'media':
                    // Forward inbound audio to agent with format conversion
                    if (agentReady && agentWs.readyState === WebSocket.OPEN && callActive) {
                        let pcmPayload = null;

                        if (smartpbxEncoding === "g711_ulaw") {
                            // Convert μ-law from SmartPBX to PCM for the agent
                            pcmPayload = convertMulawToPCM(msg.media.payload);
                            // Resample from 8kHz (SmartPBX) to 24kHz (Agent expected)
                            pcmPayload = resamplePCM(pcmPayload, 8000, 24000);
                            console.log(`[SMARTPBX->AGENT]: μ-law 8kHz → PCM16 24kHz`);
                        } else if (smartpbxEncoding === "pcm16") {
                            // Directly forward PCM16 24kHz
                            pcmPayload = msg.media.payload;
                            console.log(`[SMARTPBX->AGENT]: PCM16 24kHz passthrough`);
                        }

                        if (pcmPayload) {
                            agentWs.send(JSON.stringify({
                                mime_type: "audio/pcm",
                                data: pcmPayload,
                                role: "user"
                            }));

                            // Reduce logging frequency for audio
                            if (Math.random() < 0.01) { // Log only 1% of audio packets
                                console.log(`[SMARTPBX->AGENT]: Audio packet`);
                            }
                        }
                    }
                    break;

                // Important: This is not given in the SmartPBX docs
                case 'stop':
                    console.log('Call ended');
                    callActive = false;

                    // Send goodbye message to agent
                    if (agentWs.readyState === WebSocket.OPEN) {
                        agentWs.send(JSON.stringify({
                            mime_type: "text/plain",
                            data: "[call ended]",
                            role: "user"
                        }));

                        // Close agent connection after a brief delay
                        setTimeout(() => {
                            if (agentWs.readyState === WebSocket.OPEN) {
                                agentWs.close();
                            }
                        }, 1000);
                    }
                    break;

                default:
                    console.log('Other SmartPBX event:', msg.event);
            }

        } catch (e) {
            console.error('SmartPBX message parse error', e, message.toString());
        }
    });

    smartpbxWs.on('close', () => {
        console.log('SmartPBX WS closed');
        callActive = false;
        if (agentWs.readyState === WebSocket.OPEN) {
            agentWs.close();
        }
    });

    smartpbxWs.on('error', (err) => {
        console.error('SmartPBX WS error', err);
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        ngrok_url: `https://${smartpbx_base_url}`,
        websocket_endpoint: `wss://${smartpbx_base_url}/media-stream`,
        local_port: PORT
    });
});

// Root endpoint for webhook testing
app.get('/', (req, res) => {
    res.json({
        message: 'SmartPBX Voice Agent Bridge Server',
        webhook_url: `https://${smartpbx_base_url}`,
        health_check: `https://${smartpbx_base_url}/health`
    });
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Local SbxML webhook: http://localhost:${PORT}/`);
    console.log(`Public SbxML webhook: https://${smartpbx_base_url}/`);
    console.log(`Public WebSocket endpoint: wss://${smartpbx_base_url}/media-stream`);
    console.log(`Health check: https://${smartpbx_base_url}/health`);
    console.log('');
    console.log('📞 Your SmartPBX webhook URL should be set to:');
    console.log(`   https://${smartpbx_base_url}/`);
    console.log('');
    console.log('🔧 Make sure your Python agent is running on port 8000');
    console.log('🎵 Audio processing: auto-detect SmartPBX format (PCM16 24kHz or μ-law 8kHz)');
});