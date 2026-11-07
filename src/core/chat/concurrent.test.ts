import { describe, expect, test } from "bun:test"
import { mapConcurrently } from "./concurrent"

const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

describe("mapConcurrently", () => {
  test("never runs more than the limit at once, and returns the results in the order of the items", async () => {
    let running = 0
    let most = 0
    const results = await mapConcurrently([5, 1, 4, 2, 3, 9, 7], 3, async (item) => {
      running += 1
      most = Math.max(most, running)
      await tick()
      running -= 1
      return item * 2
    })
    expect(results).toEqual([10, 2, 8, 4, 6, 18, 14])
    expect(most).toBe(3)
  })

  test("handles no items and fewer items than the limit", async () => {
    expect(await mapConcurrently([], 4, async (item: number) => item)).toEqual([])
    expect(await mapConcurrently([1, 2], 4, async (item) => item + 1)).toEqual([2, 3])
  })

  test("starts nothing more after a failure, and throws it", async () => {
    const started: number[] = []
    const run = mapConcurrently([1, 2, 3, 4, 5, 6], 2, async (item) => {
      started.push(item)
      await tick()
      if (item === 2) throw new Error("boom")
      return item
    })
    await expect(run).rejects.toThrow("boom")
    await tick()
    await tick()
    expect(started.length).toBeLessThan(6)
    expect(started).not.toContain(6)
  })
})
