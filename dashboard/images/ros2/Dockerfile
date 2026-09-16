FROM ros:humble-ros-base-jammy
RUN apt-get update && apt-get install -y --no-install-recommends \
    ros-humble-rmw-fastrtps-cpp fastdds-tools \
    && rm -rf /var/lib/apt/lists/*
COPY dashboard/recipes/ros2 /opt/recipes/ros2
ENV RMW_IMPLEMENTATION=rmw_fastrtps_cpp
WORKDIR /opt/recipes/ros2
