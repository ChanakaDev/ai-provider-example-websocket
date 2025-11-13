# SmartPBX > AI Provider Documentation

A detailed guide for integrating your **Voice AI Agent** with **SmartPBX** using a **WebSocket Endpoint**.

---

## 📖 Table of Contents

1. What is SmartPBX > AI Provider?
2. Configuration Parameters
3. SmartPBX > AI Provider Events API
   - Event: start
   - Event: media
   - Message Flow Overview
4. Creating a WebSocket Endpoint
5. Integrating Your WebSocket Endpoint with SmartPBX
6. Frequently Asked Questions (FAQ)

---

## 🧠 Section 1. What is SmartPBX > AI Provider?

**SmartPBX > AI Provider** is a communication platform designed to deliver **Twilio-like capabilities** within **Sri Lanka**.  
It enables businesses and developers to easily connect a **Voice AI Agent** to a **Sri Lankan DID number**, allowing seamless integration of **voice automation** into local telephony systems.

---

## ⚙️ Section 2. Configuration Parameters

When configuring your AI provider to work with **SmartPBX > AI Provider**, you need to provide the following information: 

| **Field** | **Type** | **Description** |
|------------|-----------|-----------------|
| `name` | string | Display name of the SmartPBX > AI Provider. |
| `media` | Audio format and sample rate | Audio format and sample rate supported by your WebSocket endpoint. |
| `websocket_url` | string | Secure WebSocket URL used to connect to the SmartPBX > AI Provider. <br> Example: `wss://ai-agent.example.com/ws/media-stream` |
| `websocket_headers` | Key-value pairs (optional) | Key–value pairs of headers to include in the connection request. Commonly used for authorization tokens or custom metadata. |

---

## 🔄 Section 3. SmartPBX > AI Provider Events API

This section defines the **event types** exchanged over the WebSocket connection between the **SmartPBX > AI Provider** and your **WebSocket Endpoint**.Each message is a JSON object containing an `"event"` field that specifies its type.

---

### 🟢 Event: `start`

Sent once at the beginning of the WebSocket session to initialize the call context.

#### Fields
- `event` (string): Must be `"start"`.  
- `start` (object): Contains call initialization data.

#### start object
- `callId` (string): Unique identifier for the call.  
- `callerIdNumber` (string): E.164-formatted phone number of the caller.  
- `calleeIdNumber` (string): E.164-formatted phone number of the callee.  
- `accountId` (string): Account associated with the call.  
- `mediaFormat` (object): Defines the audio encoding and sample rate used for the call.

#### mediaFormat object
- `encoding` (string): Audio encoding format. Supported values are:  
  - `"pcm16"` — sample rate **24000 Hz**  
  - `"g711_ulaw"` — sample rate **8000 Hz**  
  - `"opus"` — sample rate **48000 Hz**  
- `sampleRate` (number): Must match the selected encoding.

#### 🧩 Example — Start Event

```json
{
  "event": "start",
  "start": {
    "callId": "call_12345",
    "callerIdNumber": "+1234567890",
    "calleeIdNumber": "+1234567891",
    "accountId": "acc_abc123",
    "mediaFormat": {
      "encoding": "pcm16",
      "sampleRate": 24000
    }
  }
}
```

---

### 🟣 Event: `media`

Carries audio data between your WebSocket Endpoint and the SmartPBX > AI Provider.
Multiple messages of this type are exchanged during the call.

#### Fields
- `event` (string): Must be `"media"`.  
- `media` (object): Contains the encoded audio payload.

#### media object
- `payload` (string): Base64-encoded audio data.

#### 🧩 Example — Media Event

```json
{
  "event": "media",
  "media": {
    "payload": "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQCh..."
  }
}
```

---

### 🔁 Message Flow Overview

- **Client → Server:** Sends a single `start` event to begin the session.  
- **Client ↔ Server:** Exchanges continuous `media` events containing audio frames.  
- **Connection Close:** Either side may close the WebSocket when the call ends.

---

## 🧩 Section 4. Creating a WebSocket Endpoint

In **Section 2**, We discussed the parameters required to connect to the SmartPBX > AI Provider.
One of those parameters is the **WebSocket URL**. Now we are going to create that WebSocket Endpoint.

### Key Notes

- The programming language or AI framework (e.g., **Google ADK**, **OpenAI SDK**) you are using to build your Voice AI Agent does **not** matter.  
- But you must create a **WebSocket Endpoint** capable of handling the **Start Event** and **Media Event** from SmartPBX (as explained in Section 3).  
- If your Voice AI Agent is built using a framework like **Google ADK** or **OpenAI SDK**, you may need to implement an additional **wrapper** to handle voice input and output from your Voice AI Agent.

Refer to `main.py` for examples of creating an additional wrapper around your Voice AI Agent.

> 💡 The wrapper’s purpose is to enable **voice input and output** for your AI Agent.  
> But we are developing the **WebSocket Endpoint** to process the Start and Media events.
> Don't be confused by the wrapper.

For example implementation of a WebSocket Endpoint, see the `index.js` file. If you are using a different programming language, you may have to write your own refering to the `index.js` file.

**Example WebSocket URL:**  
```
wss://ai-agent.example.com/ws/media-stream
```

> 💡 In many cases, you may not need both a wrapper and an endpoint
> you can directly build a WebSocket Endpoint that handles both events around your Voice AI Agent.

---

## 🔗 Section 5. Integrating Your WebSocket Endpoint with SmartPBX

### Step 1: Define an SmartPBX > AI Provider

1. Log in to the **SmartPBX Portal** and navigate to the **⚙️ Configuration** section.  
2. Select **# Numbers → AI Providers** from the left navigation menu.  
3. Click **+ Add**.  
4. Fill in the following details:
   - **Name:** Display name of your SmartPBX > AI Provider.  
   - **Media:** Audio format and sample rate supported by your WebSocket endpoint.  
   - **WebSocket URL:** Example — `wss://ai-agent.example.com/ws/media-stream`  
   - **WebSocket Headers:** Optional authorization tokens or metadata.

---

### Step 2: Bind the SmartPBX > AI Provider to a DID Number

1. Go to **⚙️ Configuration → # Numbers → Phone Numbers**.  
2. Select the **DID number** you want to bind to your SmartPBX > AI Provider.  
3. From the **Used by** dropdown, select the SmartPBX > AI Provider created in Step 1.

---

## ❓ Section 6. Frequently Asked Questions (FAQ)

**Q:** Do I need to use Twilio?  
**A:** No. SmartPBX is a complete alternative to Twilio, it provides almost all the **Voice call features** and **DID numbers** like Twilio.

---

**Q:** Is the audio bidirectional or unidirectional?  
**A:** The audio is **bidirectional**. SmartPBX can send and receive audio data to and from your AI Agent at the **same time**.

---

**Q:** My AI Agent is connected to SmartPBX, but I only hear silence when calling. What’s wrong?  
**A:** Please verify the following:
- Ensure **audio codecs** match between SmartPBX and your AI Agent.  
- If not, implement **conversion and resampling** functions as shown in the `index.js` file.  
- Capture the **callId** and **accountId** from the **Start Event** and include them when sending **Media** data from your AI Agent back to SmartPBX.

---

**If this document helps you, please give us a Star ⭐ on GitHub.**
