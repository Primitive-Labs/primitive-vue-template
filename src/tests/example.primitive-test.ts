import type { TestGroup } from "primitive-app";

const exampleTests: TestGroup = {
  name: "Example Tests",
  tests: [
    {
      id: "example-hello-world",
      name: "Hello World Test",
      run: async (log) => {
        log("Starting hello world test...");

        await new Promise((resolve) => setTimeout(resolve, 100));

        log("Test completed successfully!");
        return "Hello World test passed";
      },
    },
    {
      id: "example-basic-assertions",
      name: "Basic Assertions Test",
      run: async (log) => {
        log("Testing basic assertions...");

        const sum = 2 + 2;
        if (sum !== 4) {
          throw new Error(`Expected 2 + 2 = 4, got ${sum}`);
        }
        log("2 + 2 = 4 ✓");

        const greeting = "hello".toUpperCase();
        if (greeting !== "HELLO") {
          throw new Error(`Expected "HELLO", got "${greeting}"`);
        }
        log("String toUpperCase works ✓");

        return "All basic assertions passed";
      },
    },
  ],
};

export default exampleTests;
