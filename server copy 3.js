const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { format } = require("date-fns");
const chrono = require("chrono-node");
const axios = require("axios");
const dotenv = require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

// Environment variables
const MODEL_NAME = "gemini-2.0-flash-exp";
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

const getLocationCode = (locationValue) =>
  validLocations.find((location) => location.value === locationValue)?.value;

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

const fetchAvailableVehicles = async (
  pickupLocationCode,
  formattedPickupDateTime,
  formattedReturnDateTime,
  token
) => {
  const requestData = {
    locationCode: pickupLocationCode,
    pickupDate: formattedPickupDateTime,
    returnDate: formattedReturnDateTime,
    corpDiscountCode: "PAX",
    type: "go-app",
    travelProfileId: 1,
  };

  try {
    const response = await axios.post(
      "https://staging.carcierge.gorentals.com/go-app/available-vehicles",
      requestData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error("Error fetching available vehicles:", error);
    return null;
  }
};

const fetchVehicleFee = async (req, token) => {
  try {
    const response = await axios.post(
      "https://staging.carcierge.gorentals.com/go-app/vehicles-fee",
      req,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error fetching vehicle fee:", error);
    return null;
  }
};

const createBooking = async (bookingRequest, token) => {
  try {
    const response = await axios.post(
      "https://staging.carcierge.gorentals.com/go-app/create-booking",
      bookingRequest,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error creating booking:", error);
    return null;
  }
};

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
      // console.log(
      //   "Location list::::" + JSON.stringify(response.data.data.locations)
      // );
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

const extractedInfo = {
  pickupLocation: null,
  pickupLocationMatches: [],
  pickupDate: null,
  pickupTime: null,
  returnLocation: null,
  returnLocationMatches: [],
  returnDate: null,
  returnTime: null,
};

// Booking step processor
async function processBookingStep(userInput, userSession) {
  let botResponse = "";
  const { bookingDetails, currentStep } = userSession;

  async function extractBookingInfo(input, isPickup) {
    const locationText = await extractLocationWithGemini(input);

    console.log("locationText::" + locationText);

    if (locationText) {
      const locationMatches = findLocationMatch(locationText);
      if (locationMatches.length === 1) {
        console.log("1");
        if (isPickup) {
          extractedInfo.pickupLocation = locationMatches[0];
        } else {
          extractedInfo.returnLocation = locationMatches[0];
        }
      } else if (locationMatches.length > 1) {
        console.log("2");
        if (isPickup) {
          extractedInfo.pickupLocation = "multiple";
          extractedInfo.pickupLocationMatches = locationMatches;
        } else {
          extractedInfo.returnLocation = "multiple";
          extractedInfo.returnLocationMatches = locationMatches;
        }
      } else {
        console.log("3");
        if (isPickup) {
          extractedInfo.pickupLocation = locationMatches[0];
        } else {
          extractedInfo.returnLocation = locationMatches[0];
        }
      }
    } else {
      botResponse =
        "I'm here to assist you with your bookings. Could you please share the details of your request? I'd be happy to help!";
    }

    // 2. Date and Time (using chrono)
    const parsedDate = chrono.parseDate(input);
    if (parsedDate) {
      isPickup
        ? ((extractedInfo.pickupDate = format(parsedDate, "yyyy-MM-dd")),
          (extractedInfo.pickupTime = format(parsedDate, "HH:mm")))
        : ((extractedInfo.returnDate = format(parsedDate, "yyyy-MM-dd")),
          (extractedInfo.returnTime = format(parsedDate, "HH:mm")));
    } else {
      const timeRegex = /(\d{1,2}:\d{2}(?:AM|PM)?)/i;
      const timeMatch = input.match(timeRegex);
      if (timeMatch) {
        isPickup
          ? (extractedInfo.pickupTime = timeMatch[1])
          : (extractedInfo.returnTime = timeMatch[1]);
      }
    }

    return extractedInfo;
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

      console.log("prompts ::::" + userInput);

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
        if (
          bookingDetails.returnLocation &&
          bookingDetails.returnDate &&
          bookingDetails.returnTime
        ) {
          userSession.currentStep = "confirmationPending"; // Go straight to confirmation
          botResponse = `Got it! Your trip: Pickup at ${bookingDetails.pickupLocation.label} on ${bookingDetails.pickupDate} at ${bookingDetails.pickupTime}, returning to ${bookingDetails.returnLocation.label} on ${bookingDetails.returnDate} at ${bookingDetails.returnTime}. Confirm? (yes/no)`;
          break;
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
          botResponse = `Pickup at ${bookingDetails.pickupLocation.label} on ${bookingDetails.pickupDate} at ${bookingDetails.pickupTime}. Where will you be returning to??`;
          break;
        }
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

    case "returnLocation":
    case "returnDate":
    case "returnTime": {
      const extractedInfo = await extractBookingInfo(userInput, false);

      console.log(
        "extractedInfo in return::::" + JSON.stringify(extractedInfo)
      );

      // --- Location Logic ---
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

      // --- Date Logic ---
      if (extractedInfo.returnDate) {
        let parsedReturnDate;
        try {
          parsedReturnDate = chrono.parseDate(extractedInfo.returnDate);
        } catch (error) {
          console.error("Chrono parse error:", error);
        }

        if (!parsedReturnDate) {
          botResponse =
            "Invalid return date format. Please try again. Try something like 'October 26th' or '2024-10-26'.";
          userSession.currentStep = "returnDate";
          break;
        }

        const formattedReturnDate = format(parsedReturnDate, "yyyy-MM-dd");
        const pickupDate = new Date(bookingDetails.pickupDate);
        const returnDate = new Date(formattedReturnDate); // Use the parsed and formatted return date

        if (returnDate < pickupDate) {
          // Correct date comparison
          botResponse =
            "The return date cannot be earlier than the pickup date.";
          userSession.currentStep = "returnDate";
          break;
        }

        bookingDetails.returnDate = formattedReturnDate; // Store formatted date

        // Check if return time also exists, if yes, then validate it
        if (extractedInfo.returnTime) {
          let parsedReturnTime;
          try {
            parsedReturnTime = chrono.parseDate(extractedInfo.returnTime);
          } catch (error) {
            console.error("Chrono parse error:", error); // Log the error for debugging
          }

          if (!parsedReturnTime) {
            botResponse =
              "Invalid return time format. Please try again. Try something like '3:00 PM' or '15:00'."; // More helpful message
            userSession.currentStep = "returnTime";
            break; // Stay on returnTime
          }

          const returnTimeFormatted = format(parsedReturnTime, "HH:mm");

          const pickupDateTime = new Date(
            `${pickupDate.toDateString()} ${bookingDetails.pickupTime}`
          );
          const returnDateTime = new Date(
            `${returnDate.toDateString()} ${returnTimeFormatted}`
          );

          if (
            pickupDate.toDateString() === returnDate.toDateString() &&
            returnDateTime < pickupDateTime
          ) {
            botResponse =
              "The return time can't be earlier than the pickup time if both dates are the same. Please enter a valid return time.";
            userSession.currentStep = "returnTime";
            break;
          }

          bookingDetails.returnTime = returnTimeFormatted;
        } else {
          userSession.currentStep = "returnTime";
          botResponse = `Return at ${bookingDetails.returnLocation.label} on ${bookingDetails.returnDate}. What time will you be return?`;
          break;
        }
      } else {
        botResponse =
          "Invalid return date format. Please try again. Try something like 'October 26th' or '2024-10-26'.";
        userSession.currentStep = "returnDate";
        break;
      }

      // --- Time Logic ---
      if (extractedInfo.returnTime) {
        const parsedReturnTime = chrono.parseDate(extractedInfo.returnTime);
        if (!parsedReturnTime) {
          botResponse = "Invalid return time format. Please try again.";
          userSession.currentStep = "returnTime";
          break;
        }

        const returnTimeFormatted = format(parsedReturnTime, "HH:mm");

        const pickupDate = new Date(bookingDetails.pickupDate);
        const returnDate = new Date(bookingDetails.returnDate);

        const pickupDateTime = new Date(
          `${pickupDate.toDateString()} ${bookingDetails.pickupTime}`
        );
        const returnDateTime = new Date(
          `${returnDate.toDateString()} ${returnTimeFormatted}`
        );

        if (
          pickupDate.toDateString() === returnDate.toDateString() &&
          returnDateTime < pickupDateTime
        ) {
          botResponse =
            "The return time can't be earlier than the pickup time if both dates are the same. Please enter a valid return time.";
          userSession.currentStep = "returnTime";
          break;
        }

        bookingDetails.returnTime = returnTimeFormatted;
      }

      if (
        bookingDetails.returnLocation &&
        bookingDetails.returnDate &&
        bookingDetails.returnTime
      ) {
        userSession.currentStep = "confirmation";
        botResponse = `Got it! Your trip: Pickup at ${bookingDetails.pickupLocation.label} on ${bookingDetails.pickupDate} at ${bookingDetails.pickupTime}, returning to ${bookingDetails.returnLocation.label} on ${bookingDetails.returnDate} at ${bookingDetails.returnTime}.`;
        // botResponse = `Got it! Your trip: Pickup at ${bookingDetails.pickupLocation.label} on ${bookingDetails.pickupDate} at ${bookingDetails.pickupTime}, returning to ${bookingDetails.returnLocation.label} on ${bookingDetails.returnDate} at ${bookingDetails.returnTime}. Confirm? (yes/no)`;

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

        const vehicleListRes = await fetchAvailableVehicles(
          pickupLocationCode,
          formattedPickupDateTime,
          formattedReturnDateTime,
          token
        );
        if (vehicleListRes?.success && vehicleListRes.data.allVehicles) {
          userSession.vehicleList = vehicleListRes.data.allVehicles;
          console.log(
            "Vehicle list::::" + JSON.stringify(vehicleListRes.data.allVehicles)
          );
          botResponse = `Great! Here’s a list of available vehicles:\n${vehicleListRes.data.allVehicles
            .map(
              (vehicle) =>
                `${vehicle.mappedName} - ${
                  vehicle.category
                } - $${vehicle.price.toFixed(2)}`
            )
            .join("\n")}`;
          userSession.currentStep = "vehicleSelection";
        } else {
          botResponse =
            // "Sorry, no vehicles are available for your selected dates and locations.";
            "redirecting...";
        }
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

    case "confirmationPending": {
      const userInputLower = userInput.toLowerCase();
      if (userInputLower === "yes") {
        userSession.currentStep = "confirmation";
        break;
      } else if (userInputLower === "no") {
        botResponse =
          "Which detail would you like to change? (pickup location, pickup date, pickup time, return location, return date, return time)";
        userSession.currentStep = "changeField"; // New state for changing fields
        break;
      } else {
        botResponse = "Please answer 'yes' or 'no' to confirm your booking.";
        break;
      }
    }

    case "changeField": {
      const userInputLower = userInput.toLowerCase();
      switch (userInputLower) {
        case "pickup location":
          userSession.currentStep = "pickupLocation";
          botResponse = "Please enter the new pickup location.";
          break;
        case "pickup date":
          userSession.currentStep = "pickupDate";
          botResponse = "Please enter the new pickup date.";
          break;
        case "pickup time":
          userSession.currentStep = "pickupTime";
          botResponse = "Please enter the new pickup time.";
          break;
        case "return location":
          userSession.currentStep = "returnLocation";
          botResponse = "Please enter the new return location.";
          break;
        case "return date":
          userSession.currentStep = "returnDate";
          botResponse = "Please enter the new return date.";
          break;
        case "return time":
          userSession.currentStep = "returnTime";
          botResponse = "Please enter the new return time.";
          break;
        default:
          botResponse =
            "Invalid field. Please choose from: pickup location, pickup date, pickup time, return location, return date, return time";
      }
      break;
    }

    case "confirmation": {
      const userInputLower = userInput.toLowerCase();
      // if (userInputLower === "yes") {
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

      const vehicleListRes = await fetchAvailableVehicles(
        pickupLocationCode,
        formattedPickupDateTime,
        formattedReturnDateTime,
        token
      );
      if (vehicleListRes?.success && vehicleListRes.data.allVehicles) {
        userSession.vehicleList = vehicleListRes.data.allVehicles;
        console.log(
          "Vehicle list::::" + JSON.stringify(vehicleListRes.data.allVehicles)
        );
        botResponse = `Great! Here’s a list of available vehicles:\n${vehicleListRes.data.allVehicles
          .map(
            (vehicle) =>
              `${vehicle.mappedName} - ${
                vehicle.category
              } - $${vehicle.price.toFixed(2)}`
          )
          .join("\n")}`;
        userSession.currentStep = "vehicleSelection";
      } else {
        botResponse =
          "Sorry, no vehicles are available for your selected dates and locations.";
      }
      // } else {
      //   botResponse =
      //     userInputLower === "no"
      //       ? "Which detail would you like to change? (pickup location, pickup date, pickup time, return location, return date, return time)"
      //       : "Please answer 'yes' or 'no' to confirm your booking.";
      //   userSession.currentStep =
      //     userInputLower === "no" ? "changeField" : userSession.currentStep;
      // }
      break;
    }

    case "vehicleSelection": {
      const vehicleInvID = userInput;
      const selectedVehicle =
        userSession.vehicleList.find(
          (vehicle) => vehicle.InvID === vehicleInvID
        ) || null;
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

      const req = {
        locations: [
          {
            pickUpLocationCode: pickupLocationCode,
            returnLocationCode: returnLocationCode,
            primary: true,
          },
        ],
        pickupDate: formattedPickupDateTime,
        returnDate: formattedReturnDateTime,
        vehicleDetails: [
          {
            invClass: selectedVehicle?.InvClass ?? "",
            rate: selectedVehicle?.price ?? 0,
            paxCrew: "Crew",
          },
        ],
      };

      const selectedVehicleFee = await fetchVehicleFee(req, token);
      if (selectedVehicleFee) {
        const bookingRequest = {
          vehicle: {
            InvClass: selectedVehicle?.InvClass ?? "",
            Make: selectedVehicle?.Make ?? "",
            Model: selectedVehicle?.Model ?? "",
            perDayRate: selectedVehicleFee.data.totalRate.RateDescription ?? 0,
            unitNumber: selectedVehicle?.UnitNumber ?? "",
          },
          tpa: { sourceCode: "Charter", referral: "JSX", agentID: "Inflight" },
          locationCode: pickupLocationCode ?? "",
          totalRate: selectedVehicleFee.data.totalRate.TotalTM ?? "",
          estimatedRate:
            selectedVehicleFee.data.totalRate.EstimatedTotalAmount ?? "",
          pickUpDateTime: formattedPickupDateTime ?? "",
          returnDateTime: formattedReturnDateTime ?? "",
        };

        const bookingResponse = await createBooking(bookingRequest, token);
        botResponse = bookingResponse?.success
          ? "Your booking has been confirmed! Please check the Garage tab for more information."
          : "Oops! Something went wrong while creating your booking.";
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
