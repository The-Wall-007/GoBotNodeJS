const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { format } = require("date-fns");
const chrono = require("chrono-node");
const axios = require("axios");
const dotenv = require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

// Environment variables
const MODEL_NAME = "gemini-pro";
const API_KEY = process.env.API_KEY;
const token = process.env.AUTH_TOKEN;

// Middleware
app.use(express.json());

// Global state
let validLocations = [];
let validLocationLabels = [];
const userSessions = new Map(); // Store booking states per user

// Utility functions
function findLocationMatch(input) {
  const lowerInput = input.toLowerCase();
  return validLocations.filter(
    (loc) =>
      loc.value.toLowerCase().includes(lowerInput) ||
      loc.label.toLowerCase().includes(lowerInput) ||
      loc.address.toLowerCase().includes(lowerInput)
  );
}

function parseNaturalLanguageDate(input) {
  const parsedDate = chrono.parseDate(input);
  return parsedDate ? format(parsedDate, "yyyy-MM-dd") : null;
}

function parseNaturalLanguageTime(input) {
  const parsedDate = chrono.parseDate(input);
  return parsedDate ? format(parsedDate, "HH:mm") : null;
}

// Fetch locations from API
async function fetchLocations() {
  try {
    const response = await axios.get(
      "https://staging.carcierge.gorentals.com/go-app/location",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (Array.isArray(response.data?.data?.locations)) {
      validLocations = response.data.data.locations;
      validLocationLabels = validLocations.map((loc) => loc.label);
    } else {
      throw new Error("Expected response.data.data.locations to be an array");
    }
  } catch (error) {
    console.error("Error fetching locations:", error);
  }
}

// Gemini AI chat
async function runChat(userInput) {
  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({ model: MODEL_NAME });
  const chat = model.startChat();
  const result = await chat.sendMessage(userInput);
  return result.response.text();
}

// Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const { userId, userInput } = req.body;
    if (!userId || !userInput) {
      return res.status(400).json({ error: "Invalid request body" });
    }

    if (!userSessions.has(userId)) {
      userSessions.set(userId, {
        bookingDetails: {},
        currentStep: "greeting",
      });
    }

    const userSession = userSessions.get(userId);
    let botResponse = await runChat(userInput);

    try {
      const geminiJson = JSON.parse(botResponse);
      Object.assign(userSession.bookingDetails, geminiJson);
      botResponse = await processBookingStep(userInput, userSession);
    } catch (jsonError) {
      botResponse = await processBookingStep(userInput, userSession);
    }

    res.json({ response: botResponse });
  } catch (error) {
    console.error("Error in chat endpoint:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

async function extractLocationWithGemini(input) {
  const prompt = `Extract the airport or location from the following text: "${input}"\nReturn only the location name, nothing else. If no location is found, return "null".`;

  try {
    const location = await runChat(prompt); // Reuse your runChat function
    const trimmedLocation = location.trim(); // Trim whitespace

    if (trimmedLocation.toLowerCase() === "null") {
      return null;
    }
    return trimmedLocation;
  } catch (error) {
    console.error("Error extracting location with Gemini:", error);
    return null;
  }
}

let extracted = {};

// Booking step processor
async function processBookingStep(userInput, userSession) {
  let botResponse = "";
  const { bookingDetails, currentStep } = userSession;

  async function extractBookingInfo(input, isPickup) {
    const locationText = await extractLocationWithGemini(input);

    if (locationText) {
      const locationMatches = findLocationMatch(locationText);
      if (locationMatches.length === 1) {
        isPickup
          ? (extracted.pickupLocation = locationMatches[0])
          : (extracted.returnLocation = locationMatches[0]);
      } else if (locationMatches.length > 1) {
        isPickup
          ? ((extracted.pickupLocation = "multiple"),
            (extracted.pickupLocationMatches = locationMatches))
          : ((extracted.returnLocation = "multiple"),
            (extracted.returnLocationMatches = locationMatches));
      } else {
        isPickup
          ? (extracted.pickupLocation = null)
          : (extracted.returnLocation = null);
      }
    } else {
      botResponse = `I'm here to assist you with your bookings. Could you please share the details of your request? I'd be happy to help!`;
    }

    // 2. Date and Time (using chrono)
    const parsedDate = chrono.parseDate(input);
    if (parsedDate) {
      isPickup
        ? ((extracted.pickupDate = format(parsedDate, "yyyy-MM-dd")),
          (extracted.pickupTime = format(parsedDate, "HH:mm")))
        : ((extracted.returnDate = format(parsedDate, "yyyy-MM-dd")),
          (extracted.returnTime = format(parsedDate, "HH:mm")));
    } else {
      const timeRegex = /(\d{1,2}:\d{2}(?:AM|PM)?)/i;
      const timeMatch = input.match(timeRegex);
      if (timeMatch) {
        isPickup
          ? (extracted.pickupTime = timeMatch[1])
          : (extracted.returnTime = timeMatch[1]);
      }
    }

    return extracted;
  }

  switch (currentStep) {
    case "greeting":
      botResponse =
        "Hi there! I am delighted to hear that you are traveling! Where will you be landing and when should we have your vehicle ready?";
      userSession.currentStep = "pickupLocation";
      break;

    case "pickupLocation":
    case "pickupDate":
    case "pickupTime": {
      const extractedInfo = await extractBookingInfo(userInput, true);

      console.log(
        "extractedInfo in pickup::::" + JSON.stringify(extractedInfo)
      );

      if (extractedInfo.pickupLocation === "multiple") {
        botResponse = `I found multiple matches for your pickup location: ${extractedInfo.pickupLocationMatches
          .map((loc) => loc.label)
          .join(", ")}. Please be more specific.`;
        userSession.currentStep = "pickupLocation"; // Stay on pickupLocation
        break; // Important: Exit the case early
      }

      if (extractedInfo.pickupLocation) {
        bookingDetails.pickupLocation = extractedInfo.pickupLocation;
      } else {
        // Fallback to original logic if no location is found
        const locationMatches = findLocationMatch(userInput);
        if (locationMatches.length === 1) {
          bookingDetails.pickupLocation = locationMatches[0];
        } else if (locationMatches.length > 1) {
          botResponse = `I found multiple matches for your pickup location: ${locationMatches
            .map((loc) => loc.label)
            .join(", ")}. Please be more specific.`;
          userSession.currentStep = "pickupLocation";
          break;
        } else {
          botResponse = `Sorry, I couldn't find a matching location. Please choose from: ${validLocationLabels.join(
            ", "
          )}`;
          userSession.currentStep = "pickupLocation";
          break;
        }
      }

      if (extractedInfo.pickupDate) {
        bookingDetails.pickupDate = extractedInfo.pickupDate;
      }
      if (extractedInfo.pickupTime) {
        bookingDetails.pickupTime = extractedInfo.pickupTime;
      }

      if (
        bookingDetails.pickupLocation &&
        bookingDetails.pickupDate &&
        bookingDetails.pickupTime
      ) {
        userSession.currentStep = "returnLocation"; // Skip ahead!
        botResponse = `Pickup at ${bookingDetails.pickupLocation.label} on ${bookingDetails.pickupDate} at ${bookingDetails.pickupTime}. Where will you be returning to??`;
        break; // Very important to break here
      } else if (bookingDetails.pickupLocation && bookingDetails.pickupDate) {
        userSession.currentStep = "pickupTime";
        botResponse = `Pickup at ${bookingDetails.pickupLocation.label} on ${bookingDetails.pickupDate}. What time will you be picked up?`;
        break;
      } else if (bookingDetails.pickupLocation) {
        userSession.currentStep = "pickupDate";
        botResponse = `Pickup location set to ${bookingDetails.pickupLocation.label}. What is the pickup date?`;
        break;
      } else {
        userSession.currentStep = "pickupLocation";
        botResponse = "Where is your pickup location?";
        break;
      }
    }

    // case "returnLocation": {
    //   const locationMatches = findLocationMatch(userInput);
    //   if (locationMatches.length === 1) {
    //     bookingDetails.returnLocation = locationMatches[0];
    //     botResponse = `Return location set to ${locationMatches[0].label}. What is the return date? (e.g., Tomorrow, YYYY-MM-DD)`;
    //     userSession.currentStep = "returnDate";
    //   } else if (locationMatches.length > 1) {
    //     botResponse = `I found multiple matches for your return location: ${locationMatches
    //       .map((loc) => loc.label)
    //       .join(", ")}. Please be more specific.`;
    //   } else {
    //     botResponse = `Invalid location. Please choose from: ${validLocationLabels.join(
    //       ", "
    //     )}`;
    //   }
    //   break;
    // }

    // case "returnDate": {
    //   const parsedDate = parseNaturalLanguageDate(userInput);
    //   if (parsedDate) {
    //     if (new Date(parsedDate) >= new Date(bookingDetails.pickupDate)) {
    //       bookingDetails.returnDate = parsedDate;
    //       botResponse =
    //         "Got it! What time will you be returning the vehicle? (e.g., 3 PM, 16:00)";
    //       userSession.currentStep = "returnTime";
    //     } else {
    //       botResponse =
    //         "The return date can’t be earlier than the pickup date. Please enter a valid return date.";
    //     }
    //   } else {
    //     botResponse =
    //       "Hmm, I didn’t understand that date. Please try again with a valid date format.";
    //   }
    //   break;
    // }

    // case "returnTime": {
    //   const parsedTime = parseNaturalLanguageTime(userInput);
    //   if (parsedTime) {
    //     const pickupDate = new Date(bookingDetails.pickupDate);
    //     const returnDate = new Date(bookingDetails.returnDate);

    //     // Combine date and time for comparison
    //     const pickupDateTime = new Date(
    //       `${pickupDate.toDateString()} ${bookingDetails.pickupTime}`
    //     );
    //     const returnDateTime = new Date(
    //       `${returnDate.toDateString()} ${parsedTime}`
    //     );

    //     if (
    //       pickupDate.toDateString() === returnDate.toDateString() &&
    //       returnDateTime < pickupDateTime
    //     ) {
    //       botResponse =
    //         "The return time can't be earlier than the pickup time if both dates are the same. Please enter a valid return time.";
    //     } else {
    //       bookingDetails.returnTime = parsedTime;
    //       botResponse = `Got it! Your trip: Pickup at ${bookingDetails.pickupLocation.label} on ${bookingDetails.pickupDate} at ${bookingDetails.pickupTime}, returning to ${bookingDetails.returnLocation.label} on ${bookingDetails.returnDate} at ${bookingDetails.returnTime}. Confirm? (yes/no)`;
    //       userSession.currentStep = "confirmation";
    //     }
    //   } else {
    //     botResponse = "Invalid time format. Please try again.";
    //   }
    //   break;
    // }

    case "returnLocation":
    case "returnDate":
    case "returnTime": {
      const extractedInfo = await extractBookingInfo(userInput, false);

      console.log(
        "extractedInfo in return::::" + JSON.stringify(extractedInfo)
      );

      if (extractedInfo.returnLocation === "multiple") {
        botResponse = `I found multiple matches for your return location: ${extractedInfo.returnLocationMatches
          .map((loc) => loc.label)
          .join(", ")}. Please be more specific.`;
        userSession.currentStep = "returnLocation"; // Stay on returnLocation
        break; // Important: Exit the case early
      }

      if (extractedInfo.returnLocation) {
        bookingDetails.returnLocation = extractedInfo.returnLocation;
      } else {
        // Fallback to original logic if no location is found
        const locationMatches = findLocationMatch(userInput);
        if (locationMatches.length === 1) {
          bookingDetails.returnLocation = locationMatches[0];
        } else if (locationMatches.length > 1) {
          botResponse = `I found multiple matches for your return location: ${locationMatches
            .map((loc) => loc.label)
            .join(", ")}. Please be more specific.`;
          userSession.currentStep = "returnLocation";
          break;
        } else {
          botResponse = `Sorry, I couldn't find a matching location. Please choose from: ${validLocationLabels.join(
            ", "
          )}`;
          userSession.currentStep = "returnLocation";
          break;
        }
      }

      if (extractedInfo.returnDate) {
        bookingDetails.returnDate = extractedInfo.returnDate;
      }
      if (extractedInfo.returnTime) {
        bookingDetails.returnTime = extractedInfo.returnTime;
      }

      if (
        bookingDetails.returnLocation &&
        bookingDetails.returnDate &&
        bookingDetails.returnTime
      ) {
        userSession.currentStep = "confirmation"; // Skip ahead!
        botResponse = `Got it! Your trip: Pickup at ${bookingDetails.pickupLocation.label} on ${bookingDetails.pickupDate} at ${bookingDetails.pickupTime}, returning to ${bookingDetails.returnLocation.label} on ${bookingDetails.returnDate} at ${bookingDetails.returnTime}. Confirm? (yes/no)`;
        break; // Very important to break here
      } else if (bookingDetails.returnLocation && bookingDetails.returnDate) {
        userSession.currentStep = "returnTime";
        botResponse = `Return at ${bookingDetails.returnLocation.label} on ${bookingDetails.returnDate}. What time will you be return?`;
        break;
      } else if (bookingDetails.returnLocation) {
        userSession.currentStep = "returnDate";
        botResponse = `Return location set to ${bookingDetails.returnLocation.label}. What is the return date?`;
        break;
      } else {
        userSession.currentStep = "returnLocation";
        botResponse = "Where is your return location?";
        break;
      }
    }

    case "confirmation": {
      const getLocationCode = (locationValue) =>
        validLocations.find((location) => location.value === locationValue)
          ?.airportCode;

      const formatDateTime = (date, time) => {
        const [hours, minutes] = time.split(":");
        date.setHours(hours);
        date.setMinutes(minutes);
        date.setSeconds(0);

        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
          2,
          "0"
        )}-${String(date.getDate()).padStart(2, "0")}T${String(hours).padStart(
          2,
          "0"
        )}:${String(minutes).padStart(2, "0")}:00`;
      };

      const pickupLocationCode = getLocationCode(
        bookingDetails.pickupLocation.value
      );
      const returnLocationCode = getLocationCode(
        bookingDetails.returnLocation.value
      );

      const formattedPickupDateTime = formatDateTime(
        new Date(bookingDetails.pickupDate),
        bookingDetails.pickupTime
      );
      const formattedReturnDateTime = formatDateTime(
        new Date(bookingDetails.returnDate),
        bookingDetails.returnTime
      );

      try {
        const vehicleListRes = await axios.post(
          "https://staging.carcierge.gorentals.com/go-app/available-vehicles",
          {
            locationCode: pickupLocationCode,
            pickupDate: formattedPickupDateTime,
            returnDate: formattedReturnDateTime,
            corpDiscountCode: "PAX",
            type: "go-app",
            travelProfileId: 0,
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (vehicleListRes) {
          console.log("Vehicle list response received:", vehicleListRes.data);

          if (
            vehicleListRes.data.success &&
            vehicleListRes.data.data.allVehicles
          ) {
            botResponse = `Great! Here’s a list of available vehicles:\n${vehicleListRes.data.data.allVehicles
              .map(
                (vehicle) =>
                  `${vehicle.mappedName} - ${
                    vehicle.category
                  } - $${vehicle.price.toFixed(2)}`
              )
              .join("\n")}`;
          } else {
            botResponse =
              "Sorry, no vehicles are available for your selected dates and locations.";
          }
        }
      } catch (error) {
        console.error("Error in confirmation case:", error);
        botResponse =
          "Oops! Something went wrong while fetching vehicle information.";
      }

      break;
    }
  }

  return botResponse;
}

// Restart conversation
app.post("/restart", (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  // Clear the user's session
  userSessions.set(userId, {
    bookingDetails: {},
    currentStep: "greeting",
  });

  res.json({
    message: "Let me know how can I help you?",
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// Start server
app.listen(port, async () => {
  console.log(`Server is running on http://localhost:${port}`);
  await fetchLocations(); // Load locations on server start
});
