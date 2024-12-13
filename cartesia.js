// Import required modules
const fs = require("fs");
const http = require("http");
const path = require("path");
const dotenv = require("dotenv");
const twilio = require('twilio');
const ejs = require('ejs');
dotenv.config();

// Twilio
const HttpDispatcher = require("httpdispatcher");
const WebSocketServer = require("websocket").server;
const dispatcher = new HttpDispatcher();
const wsserver = http.createServer(handleRequest); // Create HTTP server to handle requests

const HTTP_SERVER_PORT = process.env.PORT || 8080; // Define the server port
let streamSid = ''; // Variable to store stream session ID

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
const deepgramTTSWebsocketURL = 'wss://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000&container=none';

// Performance Timings
let llmStart = 0;
let ttsStart = 0;
let history = [];
let firstByte = true;
let speaking = false;
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

/** Cartesia**/

const TTS_WEBSOCKET_URL = `wss://api.cartesia.ai/tts/websocket?api_key=${process.env.CARTESIA_API_KEY}&cartesia_version=2024-06-10`;
const modelId = 'sonic-english';
const voice = {
    'mode': 'id',
    'id': "694f9389-aac1-45b6-b726-9d9369183238" // You can check available voices using the Cartesia API or at https://play.cartesia.ai
};

const partialResponse = 'Hi there, my name is Cartesia. I hope youre having a great day!';

function connectToTTSWebSocket(mediaStream) {
    return new Promise((resolve, reject) => {
      console.log('Attempting to connect to TTS WebSocket');
      ttsWebSocket = new WebSocket(TTS_WEBSOCKET_URL);
  
      ttsWebSocket.on('open', () => {
        console.log('Connected to TTS WebSocket');
        resolve(ttsWebSocket);
      });
  
      ttsWebSocket.on('error', (error) => {
        console.log(`TTS WebSocket error: ${error.message}`);
        reject(error);
      });
      ttsWebSocket.on('message', (audioChunk) => {
       // const payload = data.toString('base64');
        //console.log({audioChunk});
       
        const message = {
            event: 'media',
            streamSid: streamSid,
            media: {
                payload: JSON.parse(audioChunk)['data']
            },
          };
          const messageJSON = JSON.stringify(message);
    
          // console.log('\ndeepgram TTS: Sending data.length:', data.length);
          mediaStream.connection.sendUTF(messageJSON);
        //console.log('Received audio chunk from TTS');
        
      });
      ttsWebSocket.on('close', (code, reason) => {
        console.log(`TTS WebSocket closed. Code: ${code}, Reason: ${reason}`);
        reject(new Error('TTS WebSocket closed unexpectedly'));
      });
    });
  }
  
  function sendTTSMessage(message, option ) {
    const textMessage = {
      'model_id': modelId,
      'transcript': message,
      'continue': option,
      'voice': voice,
      '__experimental_controls': {
        "speed": -0.1,
        "emotion": [
          "positivity:high",
          "curiosity"
        ]
      },
      'output_format': {
        'container': 'raw',
        'encoding': 'pcm_mulaw',
        'sample_rate': 8000
      },
      "context_id": "jerry-test"
    };
  
    console.log(`Sending message to TTS WebSocket: ${textMessage}`);
    ttsWebSocket.send(JSON.stringify(textMessage));
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
    let requestBody = req.body;
    if (!requestBody || typeof requestBody !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: "Invalid request body" }));
    }
    const decodedMessage = decodeURIComponent(requestBody.replace(/\+/g, ' '));
    const correctPrompt = decodedMessage.replace('prompt=', '')
    const dataToWrite = { prompt: correctPrompt };
    const filePath = path.join(__dirname, 'messages.json');
    fs.readFile(filePath, 'utf8', (err, data) => {
    
      fs.writeFile(filePath, JSON.stringify(dataToWrite, null, 2), 'utf8', (err) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: "Error writing to file" }));
        }
        res.writeHead(302, { 'Location': '/' });
        res.end(JSON.stringify({ message: decodedMessage }));
      });
    });

  } catch (error) {
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
  const decodedMessage = decodeURIComponent(requestBody.replace(/\+/g, ' '));
  const correctNumber = decodedMessage.replace('phone=', '')
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
   
  
    const call = await client.calls.create({
        from: '+14153587132',
        to: correctNumber,
        method: 'POST',
        url: `https://0ac7-171-78-215-102.ngrok-free.app/twiml`,
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
    this.connectToTTSWebSocket = connectToTTSWebSocket(this);
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
  let full_msg = '';
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
        //sendTTSMessage(chunk_message, true);
        //mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Speak', 'text': chunk_message }));
      }
    }
  }
  
  history.push({user : prompt, bot : full_msg})
  sendTTSMessage(full_msg, true);
  full_msg ='';
  sendTTSMessage('', false);
  //mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Flush' }));
}

function containsAnyChars(str) {
  let strArray = Array.from(str);
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

  ws.on('message', function incoming(data) {
    // Handles barge in
    if (speaking) {
      try {
        let json = JSON.parse(data.toString());
        console.log('deepgram TTS: ', data.toString());
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
      
    
     
      const payload = data.toString('base64');
      
      const message = {
        event: 'media',
        streamSid: streamSid,
        media: {
          payload,
        },
      };
      const messageJSON = JSON.stringify(message);

      // console.log('\ndeepgram TTS: Sending data.length:', data.length);
      mediaStream.connection.sendUTF(messageJSON);
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
      //console.log("deepgram STT: metadata received:", data);
      console.log("deepgram STT: metadata received");
    });
  });

  return deepgram;
};

wsserver.listen(HTTP_SERVER_PORT, function () {
  console.log("Server listening on: http://localhost:%s", HTTP_SERVER_PORT);
});
