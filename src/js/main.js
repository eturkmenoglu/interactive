// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license.

var system_prompt = `You are an AI assistant focused on delivering brief product details and assisting with the ordering process.
- Before calling a function, aim to answer product queries using existing conversational context.
- If the product information isn't clear or available, consult get_product_information for accurate details. Never invent answers.  
- Address customer account or order-related queries with the appropriate functions.
- Before seeking account specifics (like account_id), scan previous parts of the conversation. Reuse information if available, avoiding repetitive queries.
- NEVER GUESS FUNCTION INPUTS! If a user's request is unclear, request further clarification. 
- Provide responses within 3 sentences, emphasizing conciseness and accuracy.
- If not specified otherwise, the account_id of the current user is 1000
- Pay attention to the language the customer is using in their latest statement and respond in the same language!
`

const TTSVoice = "en-US-JennyMultilingualNeural" // Update this value if you want to use a different voice

const CogSvcRegion = "westeurope" // Fill your Azure cognitive services region here, e.g. westus2

const IceServerUrl = "turn:relay.communication.microsoft.com:3478" // Fill your ICE server URL here, e.g. turn:turn.azure.com:3478
let IceServerUsername
let IceServerCredential

const TalkingAvatarCharacter = "lisa"
const TalkingAvatarStyle = "casual-sitting"

//supported_languages = ["en-US", "ar-LB", "tr-TR", "ar-AE"] // The language detection engine supports a maximum of 4 languages
supported_languages = [ "tr-TR"]

default_lang = "tr-TR"

let token

const speechSynthesisConfig = SpeechSDK.SpeechConfig.fromEndpoint(new URL("wss://{region}.tts.speech.microsoft.com/cognitiveservices/websocket/v1?enableTalkingAvatar=true".replace("{region}", CogSvcRegion)))

// Global objects
var speechSynthesizer
var avatarSynthesizer
var peerConnection
var previousAnimationFrameTimestamp = 0

messages = [{ "role": "system", "content": system_prompt }];

function isBlank(str) {
    return typeof str === "string" && str.trim().length === 0;
}

function isNotBlank(str) {
    return !(typeof str === "string" && str.trim().length === 0);
}

function removeDocumentReferences(str) {
  // Regular expression to match [docX]
  var regex = /\[doc\d+\]/g;

  // Replace document references with an empty string
  var result = str.replace(regex, '');

  return result;
}

// Setup WebRTC
function setupWebRTC() {
   // Create WebRTC peer connection
   fetch("/api/getIceServerToken", {
    method: "POST"
  })
    .then(async res => {
      const reponseJson = await res.json()
      peerConnection = new RTCPeerConnection({
        iceServers: [{
          urls: reponseJson["Urls"],
          username: reponseJson["Username"],
          credential: reponseJson["Password"]
        }]
      })
    
      // Fetch WebRTC video stream and mount it to an HTML video element
      peerConnection.ontrack = function (event) {
        console.log('peerconnection.ontrack', event)
        // Clean up existing video element if there is any
        remoteVideoDiv = document.getElementById('remoteVideo')
        for (var i = 0; i < remoteVideoDiv.childNodes.length; i++) {
          if (remoteVideoDiv.childNodes[i].localName === event.track.kind) {
            remoteVideoDiv.removeChild(remoteVideoDiv.childNodes[i])
          }
        }
    
        const videoElement = document.createElement(event.track.kind)
        videoElement.id = event.track.kind
        videoElement.srcObject = event.streams[0]
        videoElement.autoplay = true
        videoElement.controls = false
        document.getElementById('remoteVideo').appendChild(videoElement)

        canvas = document.getElementById('canvas')
        remoteVideoDiv.hidden = true
        canvas.hidden = false

        videoElement.addEventListener('play', () => {
          remoteVideoDiv.style.width = videoElement.videoWidth / 2 + 'px'
          window.requestAnimationFrame(makeBackgroundTransparent)
      })
      }
    
      // Make necessary update to the web page when the connection state changes
      peerConnection.oniceconnectionstatechange = e => {
        console.log("WebRTC status: " + peerConnection.iceConnectionState)
    
        if (peerConnection.iceConnectionState === 'connected') {
          document.getElementById('loginOverlay').classList.add("hidden");
        }
    
        if (peerConnection.iceConnectionState === 'disconnected') {
        }
      }
    
      // Offer to receive 1 audio, and 1 video track
      peerConnection.addTransceiver('video', { direction: 'sendrecv' })
      peerConnection.addTransceiver('audio', { direction: 'sendrecv' })

      // start avatar, establish WebRTC connection
      avatarSynthesizer.startAvatarAsync(peerConnection).then((r) => {
        if (r.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
            console.log("[" + (new Date()).toISOString() + "] Avatar started. Result ID: " + r.resultId)
            // greeting()
        } else {
            console.log("[" + (new Date()).toISOString() + "] Unable to start avatar. Result ID: " + r.resultId)
            if (r.reason === SpeechSDK.ResultReason.Canceled) {
                let cancellationDetails = SpeechSDK.CancellationDetails.fromResult(r)
                if (cancellationDetails.reason === SpeechSDK.CancellationReason.Error) {
                    console.log(cancellationDetails.errorDetails)
                };

                console.log("Unable to start avatar: " + cancellationDetails.errorDetails);
            }
        }
    }).catch(
        (error) => {
            console.log("[" + (new Date()).toISOString() + "] Avatar failed to start. Error: " + error)
            document.getElementById('startSession').disabled = false
            document.getElementById('configuration').hidden = false
        }
    )
    })  
}

async function generateText(prompt) {

  messages.push({
    role: 'user',
    content: prompt
  });

  let generatedText
  let products
  await fetch(`/api/message`, { method: 'POST', headers: { 'Content-Type': 'application/json'}, body: JSON.stringify(messages) })
  .then(response => response.json())
  .then(data => {
    generatedText = data["messages"][data["messages"].length - 1].content;
    messages = data["messages"];
    products = data["products"]
  });

  addToConversationHistory(generatedText, 'light');
  if(products.length > 0) {
    addProductToChatHistory(products[0]);
  }
  return generatedText;
}

// Connect to TTS Avatar API
function connectToAvatarService() {
  // Construct TTS Avatar service request
  let videoCropTopLeftX = 600
  let videoCropBottomRightX = 1320
  let backgroundColor = '#00FF00FF'

  const videoFormat = new SpeechSDK.AvatarVideoFormat()
  videoFormat.setCropRange(new SpeechSDK.Coordinate(videoCropTopLeftX, 0), new SpeechSDK.Coordinate(videoCropBottomRightX, 1080));

  const avatarConfig = new SpeechSDK.AvatarConfig(TalkingAvatarCharacter, TalkingAvatarStyle, videoFormat)
  avatarConfig.backgroundColor = backgroundColor

  avatarSynthesizer = new SpeechSDK.AvatarSynthesizer(speechSynthesisConfig, avatarConfig)
  avatarSynthesizer.avatarEventReceived = function (s, e) {
      var offsetMessage = ", offset from session start: " + e.offset / 10000 + "ms."
      if (e.offset === 0) {
          offsetMessage = ""
      }
      console.log("Event received: " + e.description + offsetMessage)
  }

}

window.startSession = () => {
  var iconElement = document.createElement("i");
  iconElement.className = "fa fa-spinner fa-spin";
  iconElement.id = "loadingIcon"
  var parentElement = document.getElementById("playVideo");
  parentElement.prepend(iconElement);

  speechSynthesisConfig.speechSynthesisVoiceName = TTSVoice
  document.getElementById('playVideo').className = "round-button-hide"

  fetch("/api/getSpeechToken", {
    method: "POST"
  })
    .then(response => response.text())
    .then(response => { 
      speechSynthesisConfig.authorizationToken = response;
      token = response
    })
    .then(() => {
      speechSynthesizer = new SpeechSDK.SpeechSynthesizer(speechSynthesisConfig, null)
      connectToAvatarService()
      requestAnimationFrame(setupWebRTC)
    })
}

async function greeting() {
  addToConversationHistory("Hello, my name is Anna. How can I help you today?", "light")
  let spokenText = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='"+default_lang+"'><voice xml:lang='"+default_lang+"' xml:gender='Female' name='en-US-JennyNeural'>Merhaba ben Asli, size nasil yardimci olabilirim?</voice></speak>"
  avatarSynthesizer.speakSsmlAsync(spokenText, (result) => {
    if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
      console.log("Speech synthesized to speaker for text [ " + spokenText + " ]. Result ID: " + result.resultId)
    } else {
      console.log("Unable to speak text. Result ID: " + result.resultId)
      if (result.reason === SpeechSDK.ResultReason.Canceled) {
        let cancellationDetails = SpeechSDK.CancellationDetails.fromResult(result)
        console.log(cancellationDetails.reason)
        if (cancellationDetails.reason === SpeechSDK.CancellationReason.Error) {
          console.log(cancellationDetails.errorDetails)
        }
      }
    }
  })
}

function removeHttpLinks(text) {
    // Regular expression to match HTTP and HTTPS links
    const linkPattern = /https?:\/\/[^\s]+/g;

    // Replace the links with an empty string
    const result = text.replace(linkPattern, '');

    // Return the modified text
    return result;
}


window.speakMJ = (text) => {
  async function speakMJ(text) {
    addToConversationHistory(text, 'light')
    fetch("/api/detectLanguage?text="+text, {
      method: "POST"
    })
      .then(response => response.text())
      .then(async language => {
        console.log(`Detected language: ${language}`);

        const generatedResult = removeHttpLinks(text);
        
        language = default_lang;

        let spokenTextssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='en-US'><voice xml:lang='en-US' xml:gender='Female' name='en-US-JennyMultilingualNeural'><lang xml:lang="${language}">${generatedResult}</lang></voice></speak>`

        if (language == 'ar-AE') {
          spokenTextssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='en-US'><voice xml:lang='en-US' xml:gender='Female' name='ar-AE-FatimaNeural'><lang xml:lang="${language}">${generatedResult}</lang></voice></speak>`
        }
        let spokenText = generatedResult
        avatarSynthesizer.speakSsmlAsync(spokenTextssml, (result) => {
          if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
            console.log("Speech synthesized to speaker for text [ " + spokenText + " ]. Result ID: " + result.resultId)
          } else {
            console.log("Unable to speak text. Result ID: " + result.resultId)
            if (result.reason === SpeechSDK.ResultReason.Canceled) {
              let cancellationDetails = SpeechSDK.CancellationDetails.fromResult(result)
              console.log(cancellationDetails.reason)
              if (cancellationDetails.reason === SpeechSDK.CancellationReason.Error) {
                console.log(cancellationDetails.errorDetails)
              }
            }
          }
        })
      })
      .catch(error => {
        console.error('Error:', error);
      });
  }
  speakMJ(text);
}

window.speakMJ2 = (text) => {
  async function speakMJ2(text) {
    addToConversationHistory(text, 'dark')

    fetch("/api/detectLanguage?text="+text, {
      method: "POST"
    })
      .then(response => response.text())
      .then(async language => {
        
        language = default_lang;

        console.log(`Detected language: ${language}`);
        
        const generatedResult = removeHttpLinks(text);
        store.dispatch( {
          type: 'WEB_CHAT/SEND_MESSAGE',
          payload:
            {
              text: generatedResult
            }
        } );
      })
      .catch(error => {
        console.error('Error:', error);
      });
  }
  speakMJ2(text);
}

function showChat() {
      var chatPopup = document.getElementById("chat-container");
      chatPopup.style.display = "block"; // Set display to block
      setTimeout(function () {
      chatPopup.classList.add("show");
      }, 10); // Add the .show class after a slight delay
}

function hideChat() {
      var chatPopup = document.getElementById("chat-container");
      chatPopup.classList.remove("show");
      setTimeout(function () {
      chatPopup.style.display = "none"; // Set display to none after the transition
      }, 300); // Adjust the delay to match the transition duration
}

window.speak = (text) => {
  async function speak(text) {
    addToConversationHistory(text, 'dark')

    fetch("/api/detectLanguage?text="+text, {
      method: "POST"
    })
      .then(response => response.text())
      .then(async language => {
        language = default_lang;
        console.log(`Detected language: ${language}`);

        const generatedResult = await generateText(removeHttpLinks(text));
        
        let spokenTextssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='en-US'><voice xml:lang='en-US' xml:gender='Female' name='en-US-JennyMultilingualNeural'><lang xml:lang="${language}">${generatedResult}</lang></voice></speak>`

        if (language == 'ar-AE') {
          spokenTextssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='en-US'><voice xml:lang='en-US' xml:gender='Female' name='ar-AE-FatimaNeural'><lang xml:lang="${language}">${generatedResult}</lang></voice></speak>`
        }
        let spokenText = generatedResult
        avatarSynthesizer.speakSsmlAsync(spokenTextssml, (result) => {
          if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
            console.log("Speech synthesized to speaker for text [ " + spokenText + " ]. Result ID: " + result.resultId)
          } else {
            console.log("Unable to speak text. Result ID: " + result.resultId)
            if (result.reason === SpeechSDK.ResultReason.Canceled) {
              let cancellationDetails = SpeechSDK.CancellationDetails.fromResult(result)
              console.log(cancellationDetails.reason)
              if (cancellationDetails.reason === SpeechSDK.CancellationReason.Error) {
                console.log(cancellationDetails.errorDetails)
              }
            }
          }
        })
      })
      .catch(error => {
        console.error('Error:', error);
      });
  }
  speak(text);
}

window.stopSession = () => {
  speechSynthesizer.close()
}

window.startRecording = () => {
  const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, 'westeurope');
  speechConfig.authorizationToken = token;
  speechConfig.SpeechServiceConnection_LanguageIdMode = "Continuous";
  var autoDetectSourceLanguageConfig = SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages(supported_languages);
  // var autoDetectSourceLanguageConfig = SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages(["en-US"]);

  document.getElementById('buttonIcon').className = "fas fa-stop"
  document.getElementById('startRecording').disabled = true

  recognizer = SpeechSDK.SpeechRecognizer.FromConfig(speechConfig, autoDetectSourceLanguageConfig);

  recognizer.recognized = function (s, e) {
    if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
      console.log('Recognized:', e.result.text);
      window.stopRecording();
      // TODO: append to conversation
      window.speakMJ2(e.result.text);
    }
  };

  recognizer.startContinuousRecognitionAsync();

  console.log('Recording started.');
}

window.stopRecording = () => {
  if (recognizer) {
    recognizer.stopContinuousRecognitionAsync(
      function () {
        recognizer.close();
        recognizer = undefined;
        document.getElementById('buttonIcon').className = "fas fa-microphone"
        document.getElementById('startRecording').disabled = false
        console.log('Recording stopped.');
      },
      function (err) {
        console.error('Error stopping recording:', err);
      }
    );
  }
}

window.submitText = () => {
  document.getElementById('spokenText').textContent = document.getElementById('textinput').currentValue
  document.getElementById('textinput').currentValue = ""
  window.speak(document.getElementById('textinput').currentValue);
}


function addToConversationHistory(item, historytype) {
  const list = document.getElementById('chathistory');
  const newItem = document.createElement('li');
  newItem.classList.add('message');
  newItem.classList.add(`message--${historytype}`);
  newItem.textContent = item;
  list.appendChild(newItem);
}

function addProductToChatHistory(product) {
  const list = document.getElementById('chathistory');
  const listItem = document.createElement('li');
  listItem.classList.add('product');
  listItem.innerHTML = `
    <fluent-card class="product-card">
      <div class="product-card__header">
        <img src="${product.image_url}" alt="tent" width="100%">
      </div>
      <div class="product-card__content">
        <div><span class="product-card__price">$${product.special_offer}</span> <span class="product-card__old-price">$${product.original_price}</span></div>
        <div>${product.tagline}</div>
      </div>
    </fluent-card>
  `;
  list.appendChild(listItem);
}

// Make video background transparent by matting
function makeBackgroundTransparent(timestamp) {
  // Throttle the frame rate to 30 FPS to reduce CPU usage
  if (timestamp - previousAnimationFrameTimestamp > 30) {
      video = document.getElementById('video')
      tmpCanvas = document.getElementById('tmpCanvas')
      tmpCanvasContext = tmpCanvas.getContext('2d', { willReadFrequently: true })
      tmpCanvasContext.drawImage(video, 0, 0, video.videoWidth, video.videoHeight)
      if (video.videoWidth > 0) {
          let frame = tmpCanvasContext.getImageData(0, 0, video.videoWidth, video.videoHeight)
          for (let i = 0; i < frame.data.length / 4; i++) {
              let r = frame.data[i * 4 + 0]
              let g = frame.data[i * 4 + 1]
              let b = frame.data[i * 4 + 2]
              
              if (g - 150 > r + b) {
                  // Set alpha to 0 for pixels that are close to green
                  frame.data[i * 4 + 3] = 0
              } else if (g + g > r + b) {
                  // Reduce green part of the green pixels to avoid green edge issue
                  adjustment = (g - (r + b) / 2) / 3
                  r += adjustment
                  g -= adjustment * 2
                  b += adjustment
                  frame.data[i * 4 + 0] = r
                  frame.data[i * 4 + 1] = g
                  frame.data[i * 4 + 2] = b
                  // Reduce alpha part for green pixels to make the edge smoother
                  a = Math.max(0, 255 - adjustment * 4)
                  frame.data[i * 4 + 3] = a
              }
          }

          canvas = document.getElementById('canvas')
          canvasContext = canvas.getContext('2d')
          canvasContext.putImageData(frame, 0, 0);
      }

      previousAnimationFrameTimestamp = timestamp
  }

  window.requestAnimationFrame(makeBackgroundTransparent)
}

// var theURL = "https://3954f7b6f94747839374deb1dd3a2d.ab.environment.api.powerplatform.com/powervirtualagents/botsbyschema/crabb_copilotCsV2/directline/token?api-version=2022-03-01-preview"; 
//var theURL = "https://610ed68865d7e043af2bc9157dea82.09.environment.api.powerplatform.com/powervirtualagents/botsbyschema/crdf8_dubaiCopilot/directline/token?api-version=2022-03-01-preview";
//var theURL = "https://aad648ac97b1e507b52d7f0cb12621.1e.environment.api.powerplatform.com/powervirtualagents/botsbyschema/cr2c4_duCopilot/directline/token?api-version=2022-03-01-preview";
//var theURL="https://fcdef076dfb7456c84e8a6bf0a7df6.99.environment.api.powerplatform.com/powervirtualagents/botsbyschema/cr640_duCopilot/directline/token?api-version=2022-03-01-preview";

var theURL="https://f02541c39febede6956922b98d58f4.57.environment.api.powerplatform.com/powervirtualagents/botsbyschema/crbbf_seyahatAsistani2/directline/token?api-version=2022-03-01-preview";

var environmentEndPoint = theURL.slice(0, theURL.indexOf('/powervirtualagents'));
var apiVersion = theURL.slice(theURL.indexOf('api-version')).split('=')[1];
var regionalChannelSettingsURL = `${environmentEndPoint}/powervirtualagents/regionalchannelsettings?api-version=${apiVersion}`;

const styleOptions = {
    hideUploadButton: true,
    hideSendBox: false,
};

const store = window.WebChat.createStore(
    {},
    ({ dispatch }) => next => action => {
        if (action.type === "DIRECT_LINE/CONNECT_FULFILLED") {
            dispatch({
                meta: {
                    method: "keyboard",
                },
                payload: {
                    activity: {
                        channelData: {
                            postBack: true,
                        },
                        name: 'startConversation',
                        type: "event"//,
                    },
                },
                type: "DIRECT_LINE/POST_ACTIVITY"
            });
         }
        else if (action.type === 'DIRECT_LINE/INCOMING_ACTIVITY') {
            if (action.payload.activity.from.role === 'bot' && action.payload.activity.type === 'message') {
                if (action.payload.activity.text) { 
                    window.speakMJ(action.payload.activity.text);
                }
            }
        }
        return next(action);
    }
);
fetch(theURL)
    .then(response => response.json())
    .then(conversationInfo => {
        const webChatElement = document.getElementById('webchat');
        const chatButtonElement = document.getElementById('playVideo');
        const {createDirectLine, renderWebChat} = window.WebChat;
        chatButtonElement.addEventListener('click', function () {
                  renderWebChat(
                      {
                          directLine: createDirectLine({
                              token: conversationInfo.token,
                          }),
                          store: store,
                          styleOptions: styleOptions
                      },
                      webChatElement
                  );
              });
    })
    .catch(err => console.error("An error occurred: " + err));