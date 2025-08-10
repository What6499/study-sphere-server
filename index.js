// server.js or index.js
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
require("dotenv").config();
const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.71tnhep.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);

// ✅ Firebase Admin Initialization
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
// ✅ Firebase Token Verification Middleware
const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized: No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error("Token verification failed:", error.message);
    return res.status(403).json({ message: "Forbidden: Invalid token" });
  }
};
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("studysphere");
    const allAssignment = db.collection("allAssignments");
    const submittedAssignments = db.collection("submittedAssignments");
    const usersCollection = db.collection("usersCollection");

    app.get("/all-users", async (req, res) => {
      try {
        const { search } = req.query;

        const query = {};
        if (search) {
          query.name = { $regex: search, $options: "i" };
        }

        const users = await usersCollection.find(query).toArray();

        res.json(users);
      } catch (error) {
        console.error("Error fetching users:", error);

        res.status(500).json({ message: "Server error while fetching users." });
      }
    });
    app.get("/leaderboard", async (req, res) => {
      try {
        const leaderboardAgg = await submittedAssignments
          .aggregate([
            { $match: { status: "completed" } },
            {
              $group: {
                _id: "$userEmail",
                averageMark: { $avg: { $toDouble: "$receivedMark" } },
              },
            },
            { $sort: { averageMark: -1 } },
            { $limit: 20 },
          ])
          .toArray();

        const leaderboard = await Promise.all(
          leaderboardAgg.map(async ({ _id: email, averageMark }) => {
            const user = await usersCollection.findOne(
              { email },
              { projection: { name: 1, photo: 1 } }
            );

            return {
              email,
              name: user?.name,
              photo: user?.photo,
              averageMark: Number(averageMark.toFixed(2)),
            };
          })
        );

        res.send(leaderboard);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });
    app.get("/my-progress", verifyFirebaseToken, async (req, res) => {
      const email = req.user.email;

      const user = await usersCollection.findOne({ email });

      res.send(user.progress);
    });
    app.get("/assignments", async (req, res) => {
      const { search = "", difficulty = "" } = req.query;

      const filter = {};
      if (search) {
        filter.title = { $regex: search, $options: "i" };
      }
      if (difficulty) {
        filter.difficulty = difficulty;
      }

      const result = await allAssignment.find(filter).toArray();

      res.send(result);
    });
    app.get("/submissions", verifyFirebaseToken, async (req, res) => {
      const userEmail = req.user.email;

      try {
        const submissions = await submittedAssignments
          .find({ userEmail })
          .sort({ submittedAt: -1 })
          .toArray();

        res.send(submissions);
      } catch (error) {
        console.error(error);
      }
    });
    app.get("/pending-assignments", async (req, res) => {
      try {
        const { search = "" } = req.query;

        const filter = { status: "pending" };

        if (search) {
          filter.title = { $regex: search, $options: "i" };
        }

        const pending = await submittedAssignments
          .find(filter)
          .sort({ submittedAt: -1 })
          .toArray();

        res.send(pending);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });
    app.get("/assignments/:id", async (req, res) => {
      const assignment = await allAssignment.findOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(assignment);
    });
    app.post("/assignments", async (req, res) => {
      const assignment = req.body;
      await usersCollection.updateOne(
        { email: assignment.creatorEmail },
        { $inc: { "progress.created": 1 } }
      );
      const result = await allAssignment.insertOne(assignment);

      res.send(result);
    });
    app.get("/my-assignments", verifyFirebaseToken, async (req, res) => {
      const userEmail = req.user.email;

      const result = await allAssignment
        .find({ creatorEmail: userEmail })
        .sort({ submittedAt: -1 })
        .toArray();
      res.send(result);
    });
    ////////////////////////////// all post/////////////////////////
    app.post("/users", async (req, res) => {
      const { email, displayName, photoURL } = req.body;

      const existing = await usersCollection.findOne({ email });
      if (existing) {
        return res.send({ message: "User already exists" });
      }

      const result = await usersCollection.insertOne({
        email,
        name: displayName,
        photo: photoURL,
        progress: { created: 0, submitted: 0, marked: 0 },
      });

      res.send(result);
    });
    app.post("/submissions", async (req, res) => {
      const {
        assignmentId,
        userEmail,
        googleLink,
        note,
        title,
        status,
        marks,
        creatorName,
      } = req.body;

      const submission = {
        assignmentId,
        userEmail,
        googleLink,
        note,
        title,
        marks,
        status,
        creatorName,
        submittedAt: new Date(),
      };
      await usersCollection.updateOne(
        { email: userEmail },
        { $inc: { "progress.submitted": 1 } }
      );

      try {
        const result = await submittedAssignments.insertOne(submission);
        res.send(result);
      } catch (error) {
        console.error(error);
      }
    });

    ////////////put put//////////////
    app.put("/submissions/:id", async (req, res) => {
      const { id } = req.params;
      const { receivedMark, feedback } = req.body;

      try {
        const result = await submittedAssignments.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: "completed",
              receivedMark,
              feedback,
              markedAt: new Date(),
            },
          }
        );

        res.send({ result });
      } catch (err) {
        console.error(err);
      }
    });
    app.put("/update-assignment/:id", async (req, res) => {
      const { id } = req.params;
      const updated = req.body;
      const result = await allAssignment.updateOne(
        { _id: new ObjectId(id) },
        { $set: updated }
      );
      res.json(result);
    });

    app;

    ///////////////// lonely delete/////////
    app.delete("/assignments/:id", async (req, res) => {
      const id = req.params.id;
      const result = await allAssignment.deleteOne({ _id: new ObjectId(id) });

      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "Assignment not found" });
      }

      res.send({ message: "Assignment deleted successfully" });
    });

    // Connect the client to the server	(optional starting in v4.7)

    // Send a ping to confirm a successful connection
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
