using Xunit;

// CPU-cap and timing tests measure real scheduling on this machine; they must not compete with other tests for the processor.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
