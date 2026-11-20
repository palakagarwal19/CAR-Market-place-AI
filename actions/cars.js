"use server";

import { revalidatePath } from "next/cache";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { serializeCarData } from "@/lib/helpers";
import { analyzeImageWithBedrock } from "@/lib/bedrock";
import { deleteCarImages, uploadCarImage } from "@/lib/s3";

// Bedrock integration for car image processing
export async function processCarImageWithAI(file) {
  try {
    const prompt = `
      Analyze this car image and extract the following information:
      1. Make (manufacturer)
      2. Model
      3. Year (approximately)
      4. Color
      5. Body type (SUV, Sedan, Hatchback, etc.)
      6. Mileage
      7. Fuel type (your best guess)
      8. Transmission type (your best guess)
      9. Price (your best guess)
      9. Short Description as to be added to a car listing

      Format your response as a clean JSON object with these fields:
      {
        "make": "",
        "model": "",
        "year": 0000,
        "color": "",
        "price": "",
        "mileage": "",
        "bodyType": "",
        "fuelType": "",
        "transmission": "",
        "description": "",
        "confidence": 0.0
      }

      For confidence, provide a value between 0 and 1 representing how confident you are in your overall identification.
      Only respond with the JSON object, nothing else.
    `;

    const text = await analyzeImageWithBedrock(file, prompt);
    const cleanedText = text.replace(/```(?:json)?\n?/g, "").trim();

    // Parse the JSON response
    try {
      const carDetails = JSON.parse(cleanedText);

      // Validate the response format
      const requiredFields = [
        "make",
        "model",
        "year",
        "color",
        "bodyType",
        "price",
        "mileage",
        "fuelType",
        "transmission",
        "description",
        "confidence",
      ];

      const missingFields = requiredFields.filter(
        (field) => !(field in carDetails)
      );

      if (missingFields.length > 0) {
        throw new Error(
          `AI response missing required fields: ${missingFields.join(", ")}`
        );
      }

      // Return success response with data
      return {
        success: true,
        data: carDetails,
      };
    } catch (parseError) {
      console.error("Failed to parse AI response:", parseError);
      console.log("Raw response:", text);
      return {
        success: false,
        error: "Failed to parse AI response",
      };
    }
  } catch (error) {
    console.error("Bedrock car image analysis failed:", error);
    throw new Error("Bedrock image analysis error: " + error.message);
  }
}

// Add a car to the database with images
export async function addCar({ carData, images }) {
  const imageUrls = [];
  let savedToDatabase = false;

  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { authProviderId: userId },
    });

    if (!user) throw new Error("User not found");

    const carId = uuidv4();

    for (let i = 0; i < images.length; i++) {
      const base64Data = images[i];
      const match = base64Data?.match(
        /^data:(image\/(?:jpeg|png|webp|gif));base64,([\s\S]+)$/
      );
      if (!match) {
        console.warn("Skipping invalid image data");
        continue;
      }

      const contentType = match[1];
      const extension = contentType.split("/")[1].replace("jpeg", "jpg");
      const key = `cars/${carId}/image-${Date.now()}-${i}.${extension}`;
      const imageUrl = await uploadCarImage({
        key,
        body: Buffer.from(match[2], "base64"),
        contentType,
      });

      imageUrls.push(imageUrl);
    }

    if (imageUrls.length === 0) {
      throw new Error("No valid images were uploaded");
    }

    // Add the car to the database
    await db.car.create({
      data: {
        id: carId, // Use the same ID we used for the folder
        make: carData.make,
        model: carData.model,
        year: carData.year,
        price: carData.price,
        mileage: carData.mileage,
        color: carData.color,
        fuelType: carData.fuelType,
        transmission: carData.transmission,
        bodyType: carData.bodyType,
        seats: carData.seats,
        description: carData.description,
        status: carData.status,
        featured: carData.featured,
        images: imageUrls, // Store the array of image URLs
      },
    });
    savedToDatabase = true;

    // Revalidate the cars list page
    revalidatePath("/admin/cars");

    return {
      success: true,
    };
  } catch (error) {
    if (!savedToDatabase && imageUrls.length > 0) {
      try {
        await deleteCarImages(imageUrls);
      } catch (cleanupError) {
        console.error("Failed to clean up uploaded S3 images:", cleanupError);
      }
    }

    throw new Error("Error adding car:" + error.message);
  }
}

// Fetch all cars with simple search
export async function getCars(search = "") {
  try {
    // Build where conditions
    let where = {};

    // Add search filter
    if (search) {
      where.OR = [
        { make: { contains: search, mode: "insensitive" } },
        { model: { contains: search, mode: "insensitive" } },
        { color: { contains: search, mode: "insensitive" } },
      ];
    }

    // Execute main query
    const cars = await db.car.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    const serializedCars = cars.map(serializeCarData);

    return {
      success: true,
      data: serializedCars,
    };
  } catch (error) {
    console.error("Error fetching cars:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// Delete a car by ID
export async function deleteCar(id) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    // First, fetch the car to get its images
    const car = await db.car.findUnique({
      where: { id },
      select: { images: true },
    });

    if (!car) {
      return {
        success: false,
        error: "Car not found",
      };
    }

    // Delete the car from the database
    await db.car.delete({
      where: { id },
    });

    try {
      await deleteCarImages(car.images);
    } catch (storageError) {
      console.error("Car removed but S3 image cleanup failed:", storageError);
      return {
        success: false,
        error: "Car removed, but image cleanup failed. Contact an administrator.",
      };
    }

    // Revalidate the cars list page
    revalidatePath("/admin/cars");

    return {
      success: true,
    };
  } catch (error) {
    console.error("Error deleting car:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// Update car status or featured status
export async function updateCarStatus(id, { status, featured }) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const updateData = {};

    if (status !== undefined) {
      updateData.status = status;
    }

    if (featured !== undefined) {
      updateData.featured = featured;
    }

    // Update the car
    await db.car.update({
      where: { id },
      data: updateData,
    });

    // Revalidate the cars list page
    revalidatePath("/admin/cars");

    return {
      success: true,
    };
  } catch (error) {
    console.error("Error updating car status:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}
