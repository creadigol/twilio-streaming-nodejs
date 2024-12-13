// Import required modules
const fs = require("fs");
const http = require("http");
const path = require("path");
const dotenv = require("dotenv");
const twilio = require('twilio');
const { ElevenLabsClient } = require('elevenlabs');
const ejs = require('ejs');
const { Readable }  = require('stream');
dotenv.config();
const moment = require('moment');
const elevenlabs = new ElevenLabsClient();
const voiceId = 'QM4H4fwnlVaFDK4tn8gP';
const outputFormat = 'ulaw_8000';
const text = 'This is a test. You can now hang up. Thank you.';
// Twilio
const HttpDispatcher = require("httpdispatcher");
const WebSocketServer = require("websocket").server;
const dispatcher = new HttpDispatcher();
const wsserver = http.createServer(handleRequest); // Create HTTP server to handle requests

const HTTP_SERVER_PORT = process.env.PORT || 8080; // Define the server port
let streamSid = ''; // Variable to store stream session ID
let full_msg = '';
const mediaws = new WebSocketServer({
  httpServer: wsserver,
  autoAcceptConnections: true,
});

// Deepgram Speech to Text
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
let keepAlive;

// OpenAI
const OpenAI = require('openai');
const openai = new OpenAI();

// Deepgram Text to Speech Websocket
const WebSocket = require('ws');
const deepgramTTSWebsocketURL = 'wss://api.deepgram.com/v1/speak?encoding=mulaw&sample_rate=8000&container=none';
const model = 'eleven_turbo_v2_5';
const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${model}`;
// Performance Timings
let llmStart = 0;
let ttsStart = 0;
let firstByte = true;
let speaking = false;
let history = [];
let send_first_sentence_input_time = null;
const chars_to_check = [".", ",", "!", "?", ";", ":"]

// Function to handle HTTP requests
function handleRequest(request, response) {
  try {
    dispatcher.dispatch(request, response);
  } catch (err) {
    console.error(err);
  }
}

/*
 Easy Debug Endpoint
*/



dispatcher.onGet("/", function (req, res) {
  const filePath = path.join(__dirname, 'messages.json');
  const data = fs.readFileSync(filePath, 'utf8');
  const jsonData = JSON.parse(data);


  
  // Read the contents of the messages.json file
  fs.readFile(filePath, 'utf8', (err, content) => {
    if (err) {
      // If there's an error reading the file, handle it
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Error reading the messages file');
    }

    // Parse the data from the file (or use an empty array if the file is empty)
    let messages = [];
    try {
      messages = JSON.parse(content);
    } catch (e) {
      // If the JSON parsing fails, return an empty array
      messages = [];
    }
   
  const data = { title: 'Welcome to My App', prompt : messages?.prompt  };
  
  // Render EJS file
  ejs.renderFile(path.join(__dirname, 'views', 'index.ejs'), data, (err, str) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error rendering page');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(str);
    }
  });
});
});

dispatcher.onPost("/submit", async function (req, res) {
  try {
    // Ensure the body is properly parsed. You may need middleware to handle the body.
    let requestBody = req.body;
    
    if (!requestBody || typeof requestBody !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: "Invalid request body" }));
    }

    // Replace '+' with spaces and decode the URL-encoded string
    const decodedMessage = decodeURIComponent(requestBody.replace(/\+/g, ' '));
    const correctPrompt = decodedMessage.replace('prompt=', '')
    // Prepare the data to be written to the JSON file
    const dataToWrite = { prompt: correctPrompt };

    // Define the file path where the JSON data will be stored
    const filePath = path.join(__dirname, 'messages.json');

    // Check if the file exists
    fs.readFile(filePath, 'utf8', (err, data) => {
    
      fs.writeFile(filePath, JSON.stringify(dataToWrite, null, 2), 'utf8', (err) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: "Error writing to file" }));
        }

        // Send the response with the decoded message
        res.writeHead(302, { 'Location': '/' });
        res.end(JSON.stringify({ message: decodedMessage }));
      });
    });

  } catch (error) {
    // Handle any unexpected errors
    console.error("Error processing request:", error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: "Internal Server Error" }));
  }
})


dispatcher.onPost("/make-call", async function (req, res) {
  
  let requestBody = req.body;
    
  if (!requestBody || typeof requestBody !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: "Invalid request body" }));
  }

  // Replace '+' with spaces and decode the URL-encoded string
  const decodedMessage = decodeURIComponent(requestBody.replace(/\+/g, ' '));
  const correctNumber = decodedMessage.replace('phone=', '')
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
   
  
    const call = await client.calls.create({
        from: '+14153587132',
        to: correctNumber,
        method: 'POST',
        url: `https://0125-182-68-21-25.ngrok-free.app/twiml`,
      });
    
      res.writeHead(302, { 'Location': '/' });
      res.end("Calling.....");
  
 
});
/*
 Twilio streams.xml
*/
dispatcher.onPost("/twiml", function (req, res) {
  let filePath = path.join(__dirname + "/templates", "streams.xml");
  let stat = fs.statSync(filePath);

  res.writeHead(200, {
    "Content-Type": "text/xml",
    "Content-Length": stat.size,
  });

  let readStream = fs.createReadStream(filePath);
  readStream.pipe(res);
});

/*
  Websocket Server
*/
mediaws.on("connect", function (connection) {
  console.log("twilio: Connection accepted");
  new MediaStream(connection);
});

/*
  Twilio Bi-directional Streaming
*/
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.deepgram = setupDeepgram(this);
    this.deepgramTTSWebsocket = setupDeepgramWebsocket(this);
    connection.on("message", this.processMessage.bind(this));
    connection.on("close", this.close.bind(this));
    this.hasSeenMedia = false;

    this.messages = [];
    this.repeatCount = 0;
  }

 
  // Function to process incoming messages
  processMessage(message) {
    if (message.type === "utf8") {
      let data = JSON.parse(message.utf8Data);
      if (data.event === "connected") {
        console.log("twilio: Connected event received: ", data);
      }
      if (data.event === "start") {
        console.log("twilio: Start event received: ", data);
      }
      if (data.event === "media") {
        if (!this.hasSeenMedia) {
          console.log("twilio: Media event received: ", data);
          console.log("twilio: Suppressing additional messages...");
          this.hasSeenMedia = true;
        }
        if (!streamSid) {
          console.log('twilio: streamSid=', streamSid);
          streamSid = data.streamSid;
        }
        if (data.media.track == "inbound") {
          let rawAudio = Buffer.from(data.media.payload, 'base64');
          this.deepgram.send(rawAudio);
        }
      }
      if (data.event === "mark") {
        console.log("twilio: Mark event received", data);
      }
      if (data.event === "close") {
        console.log("twilio: Close event received: ", data);
        this.close();
      }
    } else if (message.type === "binary") {
      console.log("twilio: binary message received (not supported)");
    }
  }

  // Function to handle connection close
  close() {
    
    streamSid = '';
    history = [];
    llmStart = 0;
    ttsStart = 0;
    firstByte = true;
    speaking = false;
    send_first_sentence_input_time = null;
    console.log("twilio: Closed");
  }
}

/*
  OpenAI Streaming LLM
*/
async function promptLLM(mediaStream, prompt) {

  const filePath = path.join(__dirname, 'messages.json');
  const data = fs.readFileSync(filePath, 'utf8');
  const jsonData = JSON.parse(data);
  const instruction = [{
    role: "system",
    content : jsonData?.prompt
  }]
  history?.map(async (chat)=>{
					
    if(chat?.user){
      instruction.push({role: "user",content : chat?.user});
      
    }   
    if(chat?.bot){
      instruction.push({role: "assistant",content : chat?.bot});
      
    }
  })
  instruction.push({ role: "user", content: prompt});
  const stream = openai.beta.chat.completions.stream({
    model: 'gpt-3.5-turbo',
    stream: true,
    messages: instruction,
  });

 
  speaking = true;
  let firstToken = true;
  for await (const chunk of stream) {
    if (speaking) {
      if (firstToken) {
        const end = Date.now();
        const duration = end - llmStart;
        ttsStart = Date.now();
        console.warn('\n>>> openai LLM: Time to First Token = ', duration, '\n');
        firstToken = false;
        firstByte = true;
      }
      chunk_message = chunk.choices[0].delta.content;
      if (chunk_message) {
        process.stdout.write(chunk_message)
        if (!send_first_sentence_input_time && containsAnyChars(chunk_message)){
          send_first_sentence_input_time = Date.now();
        }
      
        full_msg += chunk_message;

       //mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Speak', 'text': chunk_message }));
      }
      
    }
  }
  console.log('Response Full', moment().format('hh:mm:ss'));

  history.push({user : prompt, bot : full_msg})
  const response = await elevenlabs.textToSpeech.convertAsStream(voiceId, {
    model_id: 'eleven_turbo_v2_5',
    output_format: outputFormat,
    text : full_msg,
    voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.5
    }
  });

  full_msg = '';
  const readableStream = Readable.from(response);
  const audioArrayBuffer = await streamToArrayBuffer(readableStream);
  console.log('Voice Start', moment().format('hh:mm:ss'));
  const message = {
      event: 'media',
      streamSid: streamSid,
      media: {
        payload: Buffer.from(audioArrayBuffer).toString('base64'),
      },
  };
  const messageJSON = JSON.stringify(message);
  mediaStream.connection.sendUTF(messageJSON);
  mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Flush' }));
}

function containsAnyChars(str) {
  // Convert the string to an array of characters
  let strArray = Array.from(str);
  
  // Check if any character in strArray exists in chars_to_check
  return strArray.some(char => chars_to_check.includes(char));
}

/*
  Deepgram Streaming Text to Speech
*/
const setupDeepgramWebsocket = (mediaStream) => {
  const options = {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
    }
  };
  const ws = new WebSocket(deepgramTTSWebsocketURL, options);

  ws.on('open', function open() {
    console.log('deepgram TTS: Connected');
  });

  ws.on('message', async function incoming(data) {
    // Handles barge in
    if (speaking) {
      try {
        let json = JSON.parse(data.toString());

        if(json.type == 'Flushed'){
          console.log('Flushed', moment().format('hh:mm:ss'));
        }
        
       
        return;
      } catch (e) {
        // Ignore
      }
      if (firstByte) {
        const end = Date.now();
        const duration = end - ttsStart;
        console.warn('\n\n>>> deepgram TTS: Time to First Byte = ', duration, '\n');
        firstByte = false;
        if (send_first_sentence_input_time){
          console.log(`>>> deepgram TTS: Time to First Byte from end of sentence token = `, (end - send_first_sentence_input_time));
        }
      }
     
     
    }
  });

  ws.on('close', function close() {
    console.log('deepgram TTS: Disconnected from the WebSocket server');
  });

  ws.on('error', function error(error) {
    console.log("deepgram TTS: error received");
    console.error(error);
  });
  return ws;
}


const setupElevenLabsTTS = async (text) => {
    try {
      // Call ElevenLabs API to get the audio stream
      const response = await elevenlabs.textToSpeech.convert(voiceId, {
        model_id: 'eleven_turbo_v2_5',
        output_format: outputFormat,
        text,
      });
  
      // Convert the response into a Buffer
      const audioBuffer = Buffer.concat(await streamToArrayBuffer(Readable.from(response)));
  
      // Return the audio buffer
      return audioBuffer;
    } catch (error) {
      console.error('Error with ElevenLabs TTS:', error);
      throw new Error('ElevenLabs TTS failed');
    }
  };

function streamToArrayBuffer(readableStream) {
    return new Promise((resolve, reject) => {
      const chunks = [];
  
      readableStream.on('data', (chunk) => {
        chunks.push(chunk);
      });
  
      readableStream.on('end', () => {
        resolve(Buffer.concat(chunks).buffer);
      });
  
      readableStream.on('error', reject);
    });
  }
  
/*
  Deepgram Streaming Speech to Text
*/
const setupDeepgram = (mediaStream) => {
  let is_finals = [];
  const deepgram = deepgramClient.listen.live({
    // Model
    model: "nova-2-phonecall",
    language: "en",
    // Formatting
    smart_format: true,
    // Audio
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    multichannel: false,
    // End of Speech
    no_delay: true,
    interim_results: true,
    endpointing: 300,
    utterance_end_ms: 1000
  });

  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    deepgram.keepAlive(); // Keeps the connection alive
  }, 10 * 1000);

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("deepgram STT: Connected");

    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (transcript !== "") {
        if (data.is_final) {
          is_finals.push(transcript);
          if (data.speech_final) {
            const utterance = is_finals.join(" ");
            is_finals = [];
            console.log(`deepgram STT: [Speech Final] ${utterance}`);
            llmStart = Date.now();
            promptLLM(mediaStream, utterance); // Send the final transcript to OpenAI for response
          } else {
            console.log(`deepgram STT:  [Is Final] ${transcript}`);
          }
        } else {
          console.log(`deepgram STT:    [Interim Result] ${transcript}`);
          if (speaking) {
            console.log('twilio: clear audio playback', streamSid);
            // Handles Barge In
            const messageJSON = JSON.stringify({
              "event": "clear",
              "streamSid": streamSid,
            });
            mediaStream.connection.sendUTF(messageJSON);
            mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Clear' }));
            speaking = false;
          }
        }
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, (data) => {
      if (is_finals.length > 0) {
        console.log("deepgram STT: [Utterance End]");
        const utterance = is_finals.join(" ");
        is_finals = [];
        console.log(`deepgram STT: [Speech Final] ${utterance}`);
        llmStart = Date.now();
        promptLLM(mediaStream, utterance);
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log("deepgram STT: disconnected");
      clearInterval(keepAlive);
      deepgram.requestClose();
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
      console.log("deepgram STT: error received");
      console.error(error);
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
      console.log("deepgram STT: warning received");
      console.warn(warning);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("deepgram STT: metadata received:", data);
    });
  });

  return deepgram;
};

wsserver.listen(HTTP_SERVER_PORT, function () {
  
  console.log("Server listening on: http://localhost:%s", HTTP_SERVER_PORT);
});
